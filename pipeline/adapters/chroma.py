"""ChromaDB adapter — the default vector store shipped with M1."""

from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

import chromadb
from chromadb.config import Settings

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Markers in chromadb error strings that mean "the on-disk schema is gone or
# unreadable" — recoverable by nuking the path and reconnecting. Anything else
# we let propagate.
_RECOVERABLE_MARKERS = (
    "no such table",
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


class ChromaAdapter(VectorDBAdapter):
    """Persistent ChromaDB-backed adapter.

    We always pass in our own embeddings; ChromaDB's default embedding function
    is disabled so the pipeline owns the embedding model end-to-end.

    The client + collection are connected lazily on first use AND recreated if
    the on-disk store has been wiped or corrupted between connections — common
    when the user's session got reset and the prior Python process held an
    in-memory client against a path that no longer exists.
    """

    def __init__(self, path: str | Path, collection: str = "corpus") -> None:
        self._path = Path(path)
        self._path.mkdir(parents=True, exist_ok=True)
        self._collection_name = collection
        self._client: chromadb.PersistentClient | None = None
        self._collection: Any = None
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
        """Drop the stale client, nuke the on-disk path, re-init from a clean slate."""
        logger.warning("ChromaDB schema unreadable at %s — recovering", self._path)
        # Drop the stale client first so it releases the sqlite handle.
        self._collection = None
        if self._client is not None:
            try:
                self._client.reset()
            except Exception:
                pass
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

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
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
        self._with_recovery(lambda: self._collection.delete(ids=ids))

    def count(self) -> int:
        return int(self._with_recovery(lambda: self._collection.count()))

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            n = self._collection.count()
            latency_ms = (time.perf_counter() - t0) * 1000.0
            return ConnectionTest(
                ok=True,
                latency_ms=latency_ms,
                detail={
                    "collection": self._collection_name,
                    "path": str(self._path),
                    "count": n,
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
