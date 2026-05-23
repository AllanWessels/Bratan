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
import logging
import os
import re
import sys
import threading
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
# Public: background ingest task
# ---------------------------------------------------------------------------


@dataclass
class _TaskState:
    state: str = "idle"
    task_id: str | None = None
    files_total: int = 0
    files_done: int = 0
    chunks_written: int = 0
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


_TASK = _TaskState()


def start_ingest_task(cfg: BratanConfig) -> IngestStatus:
    """Kick off an ingest run in a background thread.

    If a task is already running, return its current status unchanged.
    """
    with _TASK.lock:
        if _TASK.state == "running":
            return _snapshot()
        _TASK.state = "running"
        _TASK.task_id = uuid.uuid4().hex[:12]
        _TASK.files_total = 0
        _TASK.files_done = 0
        _TASK.chunks_written = 0
        _TASK.error = None

    thread = threading.Thread(target=_run_ingest, args=(cfg,), daemon=True)
    thread.start()
    return _snapshot()


def get_ingest_status() -> IngestStatus:
    return _snapshot()


def _snapshot() -> IngestStatus:
    with _TASK.lock:
        return IngestStatus(
            state=_TASK.state,  # type: ignore[arg-type]
            task_id=_TASK.task_id,
            files_total=_TASK.files_total,
            files_done=_TASK.files_done,
            chunks_written=_TASK.chunks_written,
            error=_TASK.error,
        )


def _run_ingest(cfg: BratanConfig) -> None:
    try:
        chunks_written = _ingest_sync(cfg)
        with _TASK.lock:
            _TASK.state = "succeeded"
            _TASK.chunks_written = chunks_written
    except Exception as exc:
        logger.exception("Ingest failed")
        with _TASK.lock:
            _TASK.state = "failed"
            _TASK.error = str(exc)


# ---------------------------------------------------------------------------
# Internals: the actual ingest
# ---------------------------------------------------------------------------


def _ingest_sync(cfg: BratanConfig) -> int:
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
        try:
            text = _load_text(fp)
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
                adapter.upsert(records)
                chunks_written += len(records)
        except Exception as exc:
            logger.warning("Skipped %s: %s", rel, exc)
        finally:
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

    counts: dict[str, int] = {}
    try:
        from pipeline.adapters.chroma import ChromaAdapter

        if isinstance(adapter, ChromaAdapter):
            collection = adapter._collection
            data = collection.get(include=["metadatas"])
            for meta in data.get("metadatas", []) or []:
                if not meta:
                    continue
                path = meta.get("path")
                if isinstance(path, str):
                    counts[path] = counts.get(path, 0) + 1
    except Exception as exc:
        logger.debug("Could not enumerate chunks: %s", exc)
    return counts


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
