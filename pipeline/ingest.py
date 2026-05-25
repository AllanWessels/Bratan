"""Corpus loaders, chunker, and ingestion driver.

Public surface (called from `ui/backend/app.py`):

- `list_corpus(corpus_path)` -> list[CorpusFile]
- `read_passage(corpus_path, rel_path, start, end)` -> str
- `start_ingest_task(cfg)` -> IngestStatus
- `get_ingest_status()` -> IngestStatus
- `main()` -> CLI entry
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import yaml

from pipeline.adapters.base import ChunkRecord
from pipeline.embeddings import get_embedder
from pipeline.factories import get_vectordb
from ui.backend.schemas import BratanConfig, CorpusFile, IngestStatus

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".md", ".txt", ".html", ".htm", ".pdf"}
_PIPELINE_CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"

# Per-file failures that should NOT be treated as hard ingest failures.
# Unsupported extensions / encoding errors / busted PDFs are "skip and
# continue"; anything else (chromadb write errors, embedder OOM) MUST
# surface as state="failed" so the user isn't lied to by a green status.
_SOFT_PER_FILE_ERRORS = (
    UnicodeDecodeError,
    UnicodeError,
)
_SOFT_PER_FILE_ERROR_MARKERS = (
    "Unsupported extension",
)

# How long the parent waits for the subprocess to write its first status
# heartbeat before declaring it orphaned. Generous because chromadb +
# embedder imports can take a few seconds cold.
_ORPHAN_STALE_SECONDS = 30.0


# ---------------------------------------------------------------------------
# Public: corpus listing + safe passage reads
# ---------------------------------------------------------------------------


def list_corpus(corpus_path: Path) -> list[CorpusFile]:
    """Walk the corpus and return file metadata + ingested flag.

    `ingested` is determined by the presence of any chunk in the vector store
    whose `path` metadata matches the file's relative path.
    """
    corpus_path = corpus_path.resolve()
    if not corpus_path.exists():
        return []

    files: list[CorpusFile] = []
    ingested_paths = _ingested_path_counts()
    for fp in sorted(_iter_corpus_files(corpus_path)):
        rel = fp.relative_to(corpus_path).as_posix()
        stat = fp.stat()
        n_chunks = ingested_paths.get(rel, 0)
        files.append(
            CorpusFile(
                path=rel,
                size_bytes=stat.st_size,
                modified=datetime.fromtimestamp(stat.st_mtime, tz=UTC),
                ingested=n_chunks > 0,
                n_chunks=n_chunks if n_chunks > 0 else None,
            )
        )
    return files


def read_passage(corpus_path: Path, rel_path: str, start_line: int, end_line: int) -> str:
    """Return lines [start_line, end_line] inclusive, 1-indexed.

    Resolves the file under `corpus_path` and refuses any path that escapes it.
    """
    if start_line < 1 or end_line < start_line:
        raise ValueError(f"Invalid line range: {start_line}-{end_line}")
    base = corpus_path.resolve()
    target = (base / rel_path).resolve()
    if not _is_within(target, base):
        raise PermissionError(f"Path escapes corpus root: {rel_path}")
    if not target.exists():
        raise FileNotFoundError(f"No such file under corpus: {rel_path}")

    text = _load_text(target)
    lines = text.splitlines()
    lo = max(1, start_line) - 1
    hi = min(len(lines), end_line)
    return "\n".join(lines[lo:hi])


# ---------------------------------------------------------------------------
# Public: paginated passage listing (for SME browse-the-corpus authoring)
# ---------------------------------------------------------------------------


# Window size for the file-walk passage view. ~10 lines is large enough to be
# semantically meaningful (a paragraph or a small clause) and small enough to
# scroll through comfortably.
PASSAGE_WINDOW_LINES = 10


def list_passages_paginated(
    corpus_path: Path, rel_path: str, offset: int, limit: int
) -> tuple[list[dict], int]:
    """Return a page of ``PASSAGE_WINDOW_LINES``-line windows from a corpus file.

    This is the SME-facing "browse the file" view: we deliberately skip the
    chunked vector-store records (which may be tiny or oddly split) and walk
    the source file in fixed line windows so the user reads it the way the
    author wrote it.

    Returns ``(passages, total_windows)`` where each passage dict has
    ``path``, ``line_start``, ``line_end``, ``content``, and ``score=None``.
    ``limit`` is clamped to ``[1, 50]`` and ``offset`` to ``>= 0`` to match
    the schema's validators.
    """
    limit = max(1, min(50, int(limit)))
    offset = max(0, int(offset))

    base = corpus_path.resolve()
    target = (base / rel_path).resolve()
    if not _is_within(target, base):
        raise PermissionError(f"Path escapes corpus root: {rel_path}")
    if not target.exists():
        raise FileNotFoundError(f"No such file under corpus: {rel_path}")

    text = _load_text(target)
    lines = text.splitlines()
    if not lines:
        return [], 0

    window = PASSAGE_WINDOW_LINES
    total = (len(lines) + window - 1) // window

    passages: list[dict] = []
    for i in range(offset, min(offset + limit, total)):
        start_line = i * window + 1  # 1-indexed inclusive
        end_line = min((i + 1) * window, len(lines))
        content = "\n".join(lines[start_line - 1 : end_line])
        # Skip windows that are completely blank — they read as empty cards
        # and add nothing for the SME.
        if not content.strip():
            continue
        passages.append(
            {
                "path": rel_path,
                "line_start": start_line,
                "line_end": end_line,
                "content": content,
                "score": None,
            }
        )
    return passages, total


# ---------------------------------------------------------------------------
# Public: background ingest task
# ---------------------------------------------------------------------------


@dataclass
class _TaskState:
    """In-process state used WITHIN the ingest subprocess.

    The uvicorn parent process no longer touches this — it reads
    cross-process state from a JSON status file written by the worker.
    Kept here because `_ingest_sync` still updates it (it's the natural
    progress channel for `scripts/ingest_worker._StatusReporter` to
    snapshot), and because tests import it directly.
    """

    state: str = "idle"
    task_id: str | None = None
    files_total: int = 0
    files_done: int = 0
    chunks_written: int = 0
    error: str | None = None
    current_file: str | None = None
    started_at: float | None = None  # monotonic seconds, used for chunks/sec
    lock: threading.Lock = field(default_factory=threading.Lock)


_TASK = _TaskState()


# ---- Cross-process status handle (parent process bookkeeping) -------------


@dataclass
class _SubprocessHandle:
    """What the parent (uvicorn) remembers about the most recent worker.

    The status JSON file is the source of truth; this dataclass just lets
    `get_ingest_status` find that file and detect orphans (a worker that
    exited without writing a terminal state).
    """

    task_id: str
    status_path: Path
    process: subprocess.Popen | None
    started_at: float  # monotonic seconds


_HANDLE: _SubprocessHandle | None = None
_HANDLE_LOCK = threading.Lock()


def _status_dir() -> Path:
    """Where status JSON files live. Hermetic per-project where possible."""
    root = os.environ.get("BRATAN_PROJECT_ROOT")
    if root:
        return Path(root) / ".bratan" / "ingest"
    return Path(tempfile.gettempdir()) / "bratan-ingest"


def start_ingest_task(cfg: BratanConfig) -> IngestStatus:
    """Kick off an ingest run in a fresh **subprocess**.

    Why subprocess, not thread: chromadb's Rust bindings hold process-
    level state per persistent path, and once the uvicorn process has
    poisoned that state, no in-process recovery can clear it. Isolating
    ingest to a short-lived child process means each ingest gets a fresh,
    un-poisoned chromadb client and the parent never has to recover from
    a write-path failure it doesn't know how to recover from.

    Returns a snapshot of the worker's status (which starts at
    state="running" the moment the subprocess seeds the status file).
    """
    global _HANDLE

    with _HANDLE_LOCK:
        # If a worker is already running, just surface its current status.
        if _HANDLE is not None and _is_running(_HANDLE):
            current = _read_status_file(_HANDLE)
            if current.state == "running":
                return current
            # The previous worker finished; fall through and start a new one.

        task_id = uuid.uuid4().hex[:12]
        status_dir = _status_dir()
        status_dir.mkdir(parents=True, exist_ok=True)
        status_path = status_dir / f"ingest-{task_id}.json"

        # Seed the status file BEFORE the subprocess starts so a caller
        # who polls immediately gets state="running", not "idle".
        _write_initial_status(status_path, task_id)

        # We need to hand the worker a config file it can re-load. The
        # in-memory `cfg` may differ from what's on disk (e.g. the wizard
        # has staged changes), so we serialize the live config to a tmp
        # file rather than asking the worker to re-read bratan.config.yaml.
        config_tmp = status_dir / f"config-{task_id}.yaml"
        config_tmp.write_text(
            yaml.safe_dump(cfg.model_dump(mode="json"), sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

        cmd = [
            sys.executable,
            "-m",
            "scripts.ingest_worker",
            "--config-path",
            str(config_tmp),
            "--status-path",
            str(status_path),
            "--task-id",
            task_id,
        ]
        # Always derive the worker-spawn root from __file__. NOT
        # BRATAN_PROJECT_ROOT — that's a *data* path (where bratan.config.yaml
        # and `.chroma/` live), which tests set to a tmp dir with no
        # `scripts/` directory. Same lesson as the chroma `_project_root`
        # fix in 703af35: code-root and data-root are two different things
        # and conflating them breaks `python -m scripts.ingest_worker` with
        # ModuleNotFoundError under pytest.
        project_root = Path(__file__).resolve().parents[1]
        # Scrub BRATAN_CHROMA_SUBPROCESS_QUERY from the child env. The uvicorn
        # parent sets it for read-path isolation; the ingest worker is the
        # *write* path and needs the direct in-process chromadb client. If
        # we let the flag leak through, ChromaAdapter would refuse upserts
        # with the defensive guard added alongside the query worker.
        child_env = {k: v for k, v in os.environ.items() if k != "BRATAN_CHROMA_SUBPROCESS_QUERY"}
        # Prepend project_root to PYTHONPATH so `python -m scripts.ingest_worker`
        # resolves regardless of how the parent was launched. Under uvicorn
        # PYTHONPATH is set at startup and cwd alone happens to suffice; under
        # pytest neither is reliably true and the child exits with
        # ModuleNotFoundError. Belt-and-suspenders alongside cwd= so both
        # spawn paths work without depending on caller-supplied env.
        existing_pythonpath = child_env.get("PYTHONPATH", "")
        child_env["PYTHONPATH"] = (
            str(project_root) + (os.pathsep + existing_pythonpath if existing_pythonpath else "")
        )
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(project_root),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=child_env,
                # New session — uvicorn reload / SIGTERM shouldn't take
                # the worker down with it; the worker decides when it's done.
                start_new_session=True,
            )
        except Exception as exc:
            # Couldn't spawn — write a terminal status so the caller sees
            # the failure on their next poll.
            terminal = {
                "state": "failed",
                "task_id": task_id,
                "files_total": 0,
                "files_done": 0,
                "chunks_written": 0,
                "error": f"failed to spawn ingest worker: {exc}",
                "current_file": None,
                "chunks_per_sec": None,
            }
            status_path.write_text(json.dumps(terminal), encoding="utf-8")
            _HANDLE = _SubprocessHandle(
                task_id=task_id,
                status_path=status_path,
                process=None,
                started_at=time.monotonic(),
            )
            return _to_ingest_status(terminal)

        _HANDLE = _SubprocessHandle(
            task_id=task_id,
            status_path=status_path,
            process=proc,
            started_at=time.monotonic(),
        )
        return _read_status_file(_HANDLE)


def get_ingest_status() -> IngestStatus:
    """Read the most recent worker's status file.

    If no worker has been launched in this process: state="idle". If a
    worker was launched but exited before writing a terminal state, we
    surface state="failed" with an explanatory error rather than
    perpetually returning "running" against a dead process.
    """
    with _HANDLE_LOCK:
        if _HANDLE is None:
            return IngestStatus(state="idle")
        return _read_status_file(_HANDLE)


def _is_running(handle: _SubprocessHandle) -> bool:
    """True if the worker subprocess hasn't exited yet."""
    if handle.process is None:
        return False
    return handle.process.poll() is None


def _read_status_file(handle: _SubprocessHandle) -> IngestStatus:
    """Read the worker's status JSON and project orphan-detection on top."""
    raw = _load_status_json(handle.status_path)

    if raw is None:
        # The worker hasn't written anything yet. Two cases:
        #  - it's still importing chromadb / embedder (give it a moment),
        #  - it crashed before seeding the file (treat as failed once it dies).
        if handle.process is not None and handle.process.poll() is None:
            return IngestStatus(state="running", task_id=handle.task_id)
        return IngestStatus(
            state="failed",
            task_id=handle.task_id,
            error="ingest worker exited unexpectedly",
        )

    status = _to_ingest_status(raw)

    # Orphan detection: status says "running" but the process is gone OR
    # hasn't updated the file in a long time. Surface the orphan as failed
    # rather than letting "running" stick forever.
    if status.state == "running":
        if handle.process is not None and handle.process.poll() is not None:
            return IngestStatus(
                state="failed",
                task_id=status.task_id or handle.task_id,
                files_total=status.files_total,
                files_done=status.files_done,
                chunks_written=status.chunks_written,
                error="ingest worker exited unexpectedly",
                current_file=status.current_file,
                chunks_per_sec=status.chunks_per_sec,
            )
        # Stale heartbeat — process exists but hasn't touched the file recently.
        updated_iso = raw.get("updated_at_iso")
        if isinstance(updated_iso, str):
            try:
                updated_at = datetime.fromisoformat(updated_iso)
                age = (datetime.now(UTC) - updated_at).total_seconds()
                if age > _ORPHAN_STALE_SECONDS and handle.process is None:
                    return IngestStatus(
                        state="failed",
                        task_id=status.task_id or handle.task_id,
                        error="ingest worker stopped reporting progress",
                    )
            except ValueError:
                pass

    return status


def _to_ingest_status(raw: dict) -> IngestStatus:
    """Coerce a raw status dict (worker-written) into the pydantic IngestStatus."""
    state = raw.get("state", "idle")
    if state not in {"idle", "running", "succeeded", "failed"}:
        state = "failed"
    return IngestStatus(
        state=state,  # type: ignore[arg-type]
        task_id=raw.get("task_id"),
        files_total=int(raw.get("files_total") or 0),
        files_done=int(raw.get("files_done") or 0),
        chunks_written=int(raw.get("chunks_written") or 0),
        error=raw.get("error"),
        current_file=raw.get("current_file"),
        chunks_per_sec=raw.get("chunks_per_sec"),
    )


def _load_status_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # Mid-write or transient FS issue — caller will try again on the
        # next poll. Returning None lets the orphan path do the right thing.
        return None


def _write_initial_status(path: Path, task_id: str) -> None:
    payload = {
        "state": "running",
        "task_id": task_id,
        "files_total": 0,
        "files_done": 0,
        "chunks_written": 0,
        "error": None,
        "current_file": None,
        "chunks_per_sec": None,
        "started_at_iso": datetime.now(UTC).isoformat(),
        "updated_at_iso": datetime.now(UTC).isoformat(),
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# Internals: the actual ingest
# ---------------------------------------------------------------------------


def _ingest_sync(cfg: BratanConfig) -> int:
    """Run a full ingest pass against the configured vector store.

    Failure semantics (load-bearing — the JSON status file is read by the
    parent process and surfaced to the UI):

    - **Soft, per-file failures** (unsupported extension, encoding error,
      garbled PDF page) → log a warning, skip the file, keep going. These
      don't poison the run because they don't touch the vector store.
    - **Hard failures** (chromadb write rejected, embedder OOM, missing
      table, "readonly database") → re-raise immediately. The worker
      catches the exception and writes state="failed" so the user sees a
      real error instead of "succeeded with 0 chunks".

    Why this matters: the prior behavior caught every exception per-file
    and logged it as "Skipped <file>: ...". A single chromadb error then
    caused every subsequent file to skip too, and the run ended with
    `state=succeeded, chunks_written=0`. The verifier flagged exactly that
    shape. The fix is to be honest: if the upsert path is broken, FAIL.
    """
    pipeline_cfg = _load_pipeline_config()
    chunk_size = int(pipeline_cfg.get("chunking", {}).get("size", 400))
    overlap = int(pipeline_cfg.get("chunking", {}).get("overlap", 50))
    separators = pipeline_cfg.get("chunking", {}).get(
        "separators", ["\n\n", "\n", ". ", " "]
    )

    corpus_path = Path(cfg.project.corpus_path).resolve()
    files = list(_iter_corpus_files(corpus_path))
    with _TASK.lock:
        _TASK.files_total = len(files)
        _TASK.files_done = 0
        _TASK.chunks_written = 0

    adapter = get_vectordb(cfg)
    embedder = get_embedder(cfg.models.embedding_model)

    chunks_written = 0
    for fp in files:
        rel = fp.relative_to(corpus_path).as_posix()
        with _TASK.lock:
            _TASK.current_file = rel

        # ---- Soft loader stage: skip on encoding / unsupported-extension. ----
        try:
            text = _load_text(fp)
        except _SOFT_PER_FILE_ERRORS as exc:
            logger.warning("Skipped %s (loader): %s", rel, exc)
            with _TASK.lock:
                _TASK.files_done += 1
            continue
        except ValueError as exc:
            # `_load_text` raises ValueError("Unsupported extension: ...")
            # which is a soft skip; any other ValueError is a hard failure.
            if any(marker in str(exc) for marker in _SOFT_PER_FILE_ERROR_MARKERS):
                logger.warning("Skipped %s (loader): %s", rel, exc)
                with _TASK.lock:
                    _TASK.files_done += 1
                continue
            raise

        # ---- Hard stages: chunk, embed, upsert. Any failure here is fatal. ----
        chunks = _chunk_text(text, chunk_size, overlap, separators)
        records: list[ChunkRecord] = []
        embeddings = embedder.embed([c.text for c in chunks]) if chunks else []
        for chunk, vector in zip(chunks, embeddings, strict=False):
            chunk_id = _content_hash_id(rel, chunk.start_line, chunk.end_line, chunk.text)
            records.append(
                ChunkRecord(
                    id=chunk_id,
                    text=chunk.text,
                    embedding=vector,
                    metadata={
                        "path": rel,
                        "start_line": chunk.start_line,
                        "end_line": chunk.end_line,
                    },
                )
            )
        if records:
            # If this raises, it raises. The worker writes state="failed"
            # and we never claim "succeeded with 0 chunks" again.
            adapter.upsert(records)
            chunks_written += len(records)

        with _TASK.lock:
            _TASK.files_done += 1
            _TASK.chunks_written = chunks_written

    return chunks_written


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


def _iter_corpus_files(corpus_path: Path):
    if not corpus_path.exists():
        return
    for root, _dirs, files in os.walk(corpus_path):
        # Skip the corpus README, which is meta, not content.
        for name in files:
            fp = Path(root) / name
            ext = fp.suffix.lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            if name == "README.md" and fp.parent.resolve() == corpus_path.resolve():
                continue
            yield fp


def _load_text(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in {".md", ".txt"}:
        return path.read_text(encoding="utf-8", errors="replace")
    if ext in {".html", ".htm"}:
        return _load_html(path)
    if ext == ".pdf":
        return _load_pdf(path)
    raise ValueError(f"Unsupported extension: {ext}")


def _load_html(path: Path) -> str:
    from bs4 import BeautifulSoup

    raw = path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    # collapse runs of >2 blank lines
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _load_pdf(path: Path) -> str:
    """Load PDF as line-numbered text.

    Each page contributes its lines; lines are concatenated with `\n` so that
    `start_line/end_line` indexing is well-defined across the whole document.
    """
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages_text: list[str] = []
    for page in reader.pages:
        try:
            pages_text.append(page.extract_text() or "")
        except Exception as exc:
            logger.warning("PDF page extraction failed for %s: %s", path, exc)
            pages_text.append("")
    return "\n".join(pages_text)


# ---------------------------------------------------------------------------
# Chunker
# ---------------------------------------------------------------------------


@dataclass
class _Chunk:
    text: str
    start_line: int
    end_line: int


def _chunk_text(
    text: str,
    chunk_size: int,
    overlap: int,
    separators: list[str],
) -> list[_Chunk]:
    """Recursive character chunker that preserves line numbers.

    `chunk_size` is interpreted as a *character* budget here (config calls it
    "tokens" but the M1 chunker is pre-tokenizer). The blue team can swap this
    for a tokenizer-aware variant later.
    """
    if not text.strip():
        return []
    lines = text.splitlines()
    # Build cumulative char->line index to map back to source line numbers.
    line_starts: list[int] = [0]
    for line in lines:
        line_starts.append(line_starts[-1] + len(line) + 1)  # +1 for the newline

    pieces = _recursive_split(text, chunk_size, separators)
    chunks: list[_Chunk] = []
    cursor = 0
    for piece in pieces:
        idx = text.find(piece, cursor)
        if idx < 0:
            idx = text.find(piece)
        if idx < 0:
            continue
        start_char = idx
        end_char = idx + len(piece)
        start_line = _char_to_line(start_char, line_starts)
        end_line = _char_to_line(max(start_char, end_char - 1), line_starts)
        chunks.append(_Chunk(text=piece.strip(), start_line=start_line, end_line=end_line))
        cursor = max(cursor, end_char - overlap)
    return [c for c in chunks if c.text]


def _recursive_split(text: str, chunk_size: int, separators: list[str]) -> list[str]:
    if len(text) <= chunk_size or not separators:
        return [text]
    sep = separators[0]
    rest = separators[1:]
    if not sep:
        # hard char split
        return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]

    parts = text.split(sep)
    if len(parts) == 1:
        return _recursive_split(text, chunk_size, rest)

    out: list[str] = []
    buf = ""
    for part in parts:
        candidate = (buf + sep + part) if buf else part
        if len(candidate) <= chunk_size:
            buf = candidate
            continue
        if buf:
            out.append(buf)
        if len(part) > chunk_size:
            out.extend(_recursive_split(part, chunk_size, rest))
            buf = ""
        else:
            buf = part
    if buf:
        out.append(buf)
    return out


def _char_to_line(char_offset: int, line_starts: list[int]) -> int:
    """Binary-search the 1-indexed source line for a character offset."""
    lo, hi = 0, len(line_starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_starts[mid] <= char_offset:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _content_hash_id(rel_path: str, start_line: int, end_line: int, text: str) -> str:
    text_hash = hashlib.sha1(text.encode("utf-8")).hexdigest()
    key = f"{rel_path}:{start_line}:{end_line}:{text_hash}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _load_pipeline_config() -> dict:
    if not _PIPELINE_CONFIG_PATH.exists():
        return {}
    try:
        return yaml.safe_load(_PIPELINE_CONFIG_PATH.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        logger.warning("Failed to read pipeline config: %s", exc)
        return {}


def _ingested_path_counts() -> dict[str, int]:
    """Best-effort count of chunks per source path in the active vector store.

    Returns an empty dict if the store can't be opened (fresh project, etc.).
    Used only for the corpus-list `ingested` flag.
    """
    try:
        from ui.backend.config_store import load as load_config

        project_root = Path(os.environ.get("BRATAN_PROJECT_ROOT", _PIPELINE_CONFIG_PATH.parents[1]))
        cfg = load_config(project_root / "bratan.config.yaml")
        adapter = get_vectordb(cfg)
    except Exception as exc:
        logger.debug("Vector store unavailable for corpus listing: %s", exc)
        return {}

    # Route through adapter.count_chunks_by_path() so the long-running
    # uvicorn doesn't read its stale in-memory chroma client — that's the
    # 2026-05-24 bug where ingest succeeded but every file showed
    # `ingested: false` because this function reached into _collection
    # directly, bypassing the subprocess-query path the ingest worker
    # writes through.
    try:
        from pipeline.adapters.chroma import ChromaAdapter

        if isinstance(adapter, ChromaAdapter):
            return adapter.count_chunks_by_path()
    except Exception as exc:
        logger.debug("Could not enumerate chunks: %s", exc)
    return {}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    """`uv run python -m pipeline.ingest` — runs the ingest synchronously."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    from ui.backend.config_store import load as load_config

    project_root = Path(os.environ.get("BRATAN_PROJECT_ROOT", Path(__file__).resolve().parents[1]))
    cfg = load_config(project_root / "bratan.config.yaml")

    print(f"Ingesting corpus at {cfg.project.corpus_path} -> {cfg.vector_db.adapter.value}")
    try:
        n = _ingest_sync(cfg)
        print(f"Wrote {n} chunks.")
        return 0
    except Exception as exc:
        print(f"Ingest failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
