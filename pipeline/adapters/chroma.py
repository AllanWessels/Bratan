"""ChromaDB adapter — the default vector store shipped with M1."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

import chromadb
from chromadb.config import Settings

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Env var that, when set truthy, makes every ChromaAdapter route its READ
# operations (vector_query, count, health_check) through a fresh subprocess.
# This is how the long-running uvicorn process avoids holding poisoned
# chromadb client state across resets. See `scripts/query_worker.py`.
_SUBPROCESS_QUERY_ENV = "BRATAN_CHROMA_SUBPROCESS_QUERY"

# Markers in chromadb error strings that mean "the on-disk schema is gone or
# unreadable" — recoverable by nuking the path and reconnecting. Anything else
# we let propagate.
_RECOVERABLE_MARKERS = (
    "no such table",
    "no such table: databases",  # newly observed variant; "no such table" alone
                                  # catches it, but listing it explicitly makes
                                  # the marker set greppable for future debug.
    "database disk image is malformed",
    "file is not a database",
    "DatabaseError",
    "attempt to write a readonly database",
    "code: 1032",
    "unable to open database file",
    # HNSW segment files are missing — chunks are in the SQLite metadata but
    # the vector index isn't on disk. Happens when .chroma is partially wiped
    # under a live client. We recover by nuking + reconnecting; the next
    # operation against an empty collection returns gracefully.
    "Nothing found on disk",
    "Error creating hnsw segment reader",
    "hnsw segment",
)


def _truthy(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


# Repo root computed from this file's location: chroma.py lives at
# pipeline/adapters/chroma.py so parents[2] is the project root. Tests that
# instantiate ChromaAdapter against this path (e.g. via BratanConfig()'s
# default `./.chroma`) would poison the real on-disk store the live UI
# reads from. The pytest-time guard below refuses that combination.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PROJECT_DEFAULT_CHROMA_PATH = (_REPO_ROOT / ".chroma").resolve()


def _refuse_project_default_under_pytest(path: Path) -> None:
    """Belt-and-braces: refuse to open ./.chroma under pytest.

    The StubEmbedder used in tests produces 32-dim vectors; if any of those
    landed in the real on-disk store, the next live BGE-small call (384-dim)
    would 500 with "Collection expecting embedding with dimension of 32".
    Tests should always pass an explicit tmp_path-based ``chroma_path``;
    if they don't, fail loud here rather than silently corrupting state
    across sessions.
    """
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        # Path doesn't exist yet — that's fine for the comparison; resolve
        # against the parent so a planned `.chroma` location still matches.
        resolved = (Path.cwd() / path).resolve()
    if resolved == _PROJECT_DEFAULT_CHROMA_PATH:
        test_name = os.environ.get("PYTEST_CURRENT_TEST", "<unknown>")
        raise RuntimeError(
            f"ChromaAdapter must use a tmp path during pytest. "
            f"Got the project-default path {resolved}, which would poison "
            f"the real on-disk store. Test: {test_name}. "
            f"Pass an explicit chroma_path=tmp_path/'chroma' (or set "
            f"cfg.vector_db.chroma_path to a tmp location)."
        )


# Process-wide registry of live ChromaAdapter instances. Used by
# `drop_in_process_clients()` so the reset endpoint can null out every
# retained adapter handle, not just the most recently-constructed one.
# Stored as a plain set (not WeakSet) because chromadb's Rust-backed
# PersistentClient is the resource we care about pinning, and we want
# explicit lifecycle: ChromaAdapter.__init__ adds, drop_in_process_clients
# removes.
_LIVE_ADAPTERS: "set[ChromaAdapter]" = set()


def drop_in_process_clients() -> bool:
    """Wipe every in-process chromadb client + collection reference.

    Called by `POST /api/system/reset-vector-store` *after* the on-disk
    ``.chroma/`` path has been removed. Without this step, a subsequent
    adapter construction in the same Python process reuses chromadb's
    cached ``SharedSystemClient`` (which holds a sqlite handle pointing
    at the now-deleted directory) and raises
    "unable to open database file".

    Sequence:
      1. Walk every live ChromaAdapter, null its client + collection refs.
      2. Clear chromadb's process-wide ``SharedSystemClient`` cache.

    Returns True if any state was actually cleared, False if nothing was
    held (purely informational — callers shouldn't branch on it).
    """
    cleared_any = False
    for adapter in list(_LIVE_ADAPTERS):
        try:
            adapter._collection = None
            if adapter._client is not None:
                try:
                    # reset() needs allow_reset=True; we set it in _connect.
                    adapter._client.reset()
                except Exception as exc:
                    logger.debug(
                        "client.reset() in drop_in_process_clients raised: %s", exc
                    )
                adapter._client = None
                cleared_any = True
        finally:
            _LIVE_ADAPTERS.discard(adapter)

    # Even if no adapter is currently registered, chromadb's own process-wide
    # cache may still hold a handle to the wiped path. Clear it.
    try:
        from chromadb.api.shared_system_client import SharedSystemClient

        if getattr(SharedSystemClient, "_identifier_to_system", None):
            cleared_any = True
        SharedSystemClient.clear_system_cache()
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("clear_system_cache() raised: %s", exc)

    return cleared_any


class ChromaAdapter(VectorDBAdapter):
    """Persistent ChromaDB-backed adapter.

    We always pass in our own embeddings; ChromaDB's default embedding function
    is disabled so the pipeline owns the embedding model end-to-end.

    The client + collection are connected lazily on first use AND recreated if
    the on-disk store has been wiped or corrupted between connections — common
    when the user's session got reset and the prior Python process held an
    in-memory client against a path that no longer exists.
    """

    def __init__(
        self,
        path: str | Path,
        collection: str = "corpus",
        *,
        subprocess_query: bool | None = None,
        **_: Any,
    ) -> None:
        self._path = Path(path)
        _refuse_project_default_under_pytest(self._path)
        self._path.mkdir(parents=True, exist_ok=True)
        self._collection_name = collection
        self._client: chromadb.PersistentClient | None = None
        self._collection: Any = None
        # Read-path isolation: when on, vector_query / count / health_check
        # spawn `scripts.query_worker` instead of touching the in-process
        # chromadb client. The flag is opt-in (kwarg) with env-var fallback so
        # production (uvicorn) flips it on at startup and unit tests keep the
        # fast in-process path by default.
        if subprocess_query is None:
            subprocess_query = _truthy(os.environ.get(_SUBPROCESS_QUERY_ENV))
        self._subprocess_query = bool(subprocess_query)

        if self._subprocess_query:
            # Deliberately do NOT call `_connect()` — opening the persistent
            # client here would re-poison the parent process, which is the
            # whole problem this flag exists to dodge. The subprocess opens
            # its own fresh client per call.
            logger.info(
                "ChromaAdapter at %s: read path routed to %s subprocess",
                self._path,
                "scripts.query_worker",
            )
            _LIVE_ADAPTERS.add(self)
            return

        # __init__ MUST also recover — the user's "no such table: tenants" hit
        # on first get_or_create_collection. Wrapping connect itself.
        try:
            self._connect()
        except Exception as exc:
            msg = str(exc)
            if not any(marker in msg for marker in _RECOVERABLE_MARKERS):
                raise
            logger.warning("Recovering from chromadb init error: %s", exc)
            self._recover()
        _LIVE_ADAPTERS.add(self)

    def _connect(self) -> None:
        self._path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(self._path),
            settings=Settings(anonymized_telemetry=False, allow_reset=True),
        )
        # Force the schema-migration codepath BEFORE touching collections so
        # we surface (and recover from) the "no such table: tenants" race that
        # otherwise fires inside get_or_create_collection.
        try:
            self._client.heartbeat()
        except Exception as exc:
            logger.debug("Initial heartbeat failed (will let _connect retry): %s", exc)
        self._collection = self._client.get_or_create_collection(
            name=self._collection_name,
            embedding_function=None,
            metadata={"hnsw:space": "cosine"},
        )

    def _recover(self) -> None:
        """Drop the stale client, nuke the on-disk path, re-init from a clean slate.

        Sequence matters: chromadb's Rust bindings hold process-level state
        per persistent path. To get out of the "readonly database" /
        "no such table: tenants" hole, we must (a) call client.reset() to
        clear chromadb's own internal caches, (b) drop our local reference,
        (c) wipe the on-disk path, (d) reconnect.
        """
        logger.warning("ChromaDB schema unreadable at %s — recovering", self._path)
        self._collection = None
        if self._client is not None:
            try:
                # reset() requires allow_reset=True in Settings (we set it).
                # It also clears chromadb's internal SqliteAPI caches.
                self._client.reset()
            except Exception as exc:
                logger.debug("client.reset() during recovery raised: %s", exc)
            self._client = None
        if self._path.exists():
            shutil.rmtree(self._path, ignore_errors=True)
        self._connect()

    def _with_recovery(self, op: Callable[[], T]) -> T:
        try:
            return op()
        except Exception as exc:
            msg = str(exc)
            if not any(marker in msg for marker in _RECOVERABLE_MARKERS):
                raise
            logger.warning("Recovering from chromadb error: %s", exc)
            self._recover()
            return op()

    # ------------------------------------------------------------------
    # Subprocess read path
    # ------------------------------------------------------------------

    def _project_root(self) -> Path:
        """Repo root where `scripts/` lives — always derived from __file__.

        Intentionally NOT `BRATAN_PROJECT_ROOT`: that env var is a *data*
        path (where `bratan.config.yaml` and `.chroma/` live), which the
        wizard and tests set to a per-project tmpdir. The worker is a
        *code* module that must be importable as `scripts.query_worker`,
        and that import resolves only from the actual repo root. Under
        pytest the two diverge — honoring BRATAN_PROJECT_ROOT here points
        cwd at a tmpdir with no `scripts/`, and `python -m
        scripts.query_worker` exits with ModuleNotFoundError.
        """
        return Path(__file__).resolve().parents[2]

    def _subprocess_call(self, op: str, **payload: Any) -> dict[str, Any]:
        """Run one query op in `scripts.query_worker` and parse its JSON reply.

        We pass ``chroma_path`` + ``chroma_collection`` directly (Form B in
        the worker's docstring) so the adapter doesn't need a BratanConfig
        in hand. The child process always opens chromadb fresh — that's the
        whole point of this routing layer.
        """
        request = {
            "op": op,
            "chroma_path": str(self._path),
            "chroma_collection": self._collection_name,
            **payload,
        }
        # Strip our own env flag from the child so we never recurse. The
        # worker scrubs it again as belt-and-braces.
        child_env = {k: v for k, v in os.environ.items() if k != _SUBPROCESS_QUERY_ENV}
        # Prepend project_root to PYTHONPATH so `python -m scripts.query_worker`
        # resolves regardless of how the parent was launched. Under uvicorn
        # PYTHONPATH is set at startup and cwd alone happens to suffice; under
        # pytest neither is reliably true and the child exits with
        # ModuleNotFoundError. Belt-and-suspenders: set cwd AND PYTHONPATH so
        # both spawn paths work without depending on caller-supplied env.
        project_root = self._project_root()
        existing_pythonpath = child_env.get("PYTHONPATH", "")
        child_env["PYTHONPATH"] = (
            str(project_root) + (os.pathsep + existing_pythonpath if existing_pythonpath else "")
        )

        try:
            proc = subprocess.run(
                [sys.executable, "-m", "scripts.query_worker"],
                input=json.dumps(request),
                capture_output=True,
                text=True,
                cwd=str(project_root),
                env=child_env,
                # Reads should be quick; cap at 60s so a wedged worker can't
                # hang the request indefinitely.
                timeout=60.0,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"chroma query worker timed out after {exc.timeout}s "
                f"(op={op!r}, path={self._path})"
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                f"failed to spawn chroma query worker (op={op!r}): {exc}"
            ) from exc

        stdout = (proc.stdout or "").strip()
        if not stdout:
            stderr = (proc.stderr or "").strip()
            raise RuntimeError(
                f"chroma query worker produced no output "
                f"(op={op!r}, exit={proc.returncode}, stderr={stderr!r})"
            )
        try:
            payload_out = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"chroma query worker emitted non-JSON output: {stdout!r}"
            ) from exc

        if not payload_out.get("ok"):
            err = payload_out.get("error", "unknown subprocess error")
            raise RuntimeError(f"chroma query worker {op!r} failed: {err}")
        return payload_out

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        if self._subprocess_query:
            # Writes belong to scripts.ingest_worker (a different short-lived
            # process). The uvicorn-side adapter should never reach this; if
            # it does, fail loudly rather than silently re-opening chromadb
            # and re-introducing the poisoning we just engineered around.
            raise RuntimeError(
                "ChromaAdapter is in subprocess_query mode; writes must go "
                "through scripts.ingest_worker, not the live FastAPI process."
            )
        ids = [it.id for it in items]
        embeddings = [it.embedding for it in items]
        documents = [it.text for it in items]
        metadatas = [_flatten_metadata(it.metadata) for it in items]
        self._with_recovery(
            lambda: self._collection.upsert(
                ids=ids,
                embeddings=embeddings,
                documents=documents,
                metadatas=metadatas,
            )
        )

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        if self._subprocess_query:
            result = self._subprocess_call("vector_query", embedding=embedding, k=int(k))
            return [
                QueryHit(
                    id=h["id"],
                    text=h.get("text", ""),
                    score=float(h.get("score", 0.0)),
                    metadata=h.get("metadata", {}) or {},
                )
                for h in result.get("hits", [])
            ]
        try:
            result = self._with_recovery(
                lambda: self._collection.query(
                    query_embeddings=[embedding],
                    n_results=max(1, k),
                    include=["documents", "metadatas", "distances"],
                )
            )
        except Exception as exc:
            # Recovery just nuked + reconnected to an empty collection; a
            # query against an empty collection returns empty hits, not 500.
            if self.count() == 0:
                logger.info("vector_query against empty collection after recovery: %s", exc)
                return []
            raise
        return _hits_from_chroma_result(result)

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        # ChromaDB has no native BM25 — caller stitches hybrid retrieval itself.
        return None

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        if self._subprocess_query:
            raise RuntimeError(
                "ChromaAdapter is in subprocess_query mode; deletes must go "
                "through scripts.ingest_worker, not the live FastAPI process."
            )
        self._with_recovery(lambda: self._collection.delete(ids=ids))

    def count(self) -> int:
        if self._subprocess_query:
            result = self._subprocess_call("count")
            return int(result.get("count", 0))
        return int(self._with_recovery(lambda: self._collection.count()))

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            # Use self.count() so we go through _with_recovery (or the
            # subprocess) — bypassing it is what made the "Test connection"
            # button surface the raw "no such table: tenants" error to the
            # user.
            n = self.count()
            latency_ms = (time.perf_counter() - t0) * 1000.0
            return ConnectionTest(
                ok=True,
                latency_ms=latency_ms,
                detail={
                    "collection": self._collection_name,
                    "path": str(self._path),
                    "count": n,
                    "subprocess_query": self._subprocess_query,
                },
            )
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """ChromaDB only accepts scalar metadata values."""
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _hits_from_chroma_result(result: dict[str, Any]) -> list[QueryHit]:
    ids = (result.get("ids") or [[]])[0]
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    hits: list[QueryHit] = []
    for i, _id in enumerate(ids):
        # cosine distance -> similarity score
        distance = float(dists[i]) if i < len(dists) and dists[i] is not None else 0.0
        score = 1.0 - distance
        hits.append(
            QueryHit(
                id=_id,
                text=docs[i] if i < len(docs) else "",
                score=score,
                metadata=metas[i] if i < len(metas) and metas[i] else {},
            )
        )
    return hits
