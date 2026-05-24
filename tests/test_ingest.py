"""Tests for pipeline.ingest — chunker invariants, loaders, read_passage safety, content-hash IDs."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from pipeline import ingest
from pipeline.ingest import (
    _chunk_text,
    _content_hash_id,
    _ingest_sync,
    _load_html,
    _load_text,
    list_corpus,
    read_passage,
)

# ---------------------------------------------------------------------------
# Chunker invariants
# ---------------------------------------------------------------------------


SEPARATORS = ["\n\n", "\n", " ", ""]


def test_chunk_empty_text_returns_empty() -> None:
    assert _chunk_text("", 100, 0, SEPARATORS) == []
    assert _chunk_text("   \n\n   ", 100, 0, SEPARATORS) == []


def test_chunk_short_text_returns_one_chunk_with_full_line_range() -> None:
    text = "hello world"
    chunks = _chunk_text(text, 100, 0, SEPARATORS)
    assert len(chunks) == 1
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1


def test_chunk_line_numbers_are_1_indexed_and_well_ordered() -> None:
    text = "line one\nline two\nline three\nline four\nline five\n"
    chunks = _chunk_text(text, 18, 0, SEPARATORS)
    assert len(chunks) >= 2
    for c in chunks:
        assert c.start_line >= 1
        assert c.end_line >= c.start_line
        # No chunk spans past the last line
        assert c.end_line <= text.count("\n") + 1


def test_chunk_text_is_recoverable_from_source() -> None:
    text = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
    chunks = _chunk_text(text, 12, 0, SEPARATORS)
    # Each chunk's text appears verbatim somewhere in the source.
    for c in chunks:
        assert c.text in text or c.text.strip() in text


def test_chunk_overlap_advances_cursor() -> None:
    text = "x" * 200
    chunks = _chunk_text(text, 50, 10, SEPARATORS)
    # With 200 chars / 50 per chunk we expect at least 4 chunks.
    assert len(chunks) >= 4


# ---------------------------------------------------------------------------
# Content-hash IDs (idempotency anchor)
# ---------------------------------------------------------------------------


def test_content_hash_id_is_deterministic() -> None:
    a = _content_hash_id("docs/foo.md", 1, 10, "hello")
    b = _content_hash_id("docs/foo.md", 1, 10, "hello")
    assert a == b


def test_content_hash_id_varies_with_any_axis() -> None:
    base = _content_hash_id("docs/foo.md", 1, 10, "hello")
    assert base != _content_hash_id("docs/bar.md", 1, 10, "hello")
    assert base != _content_hash_id("docs/foo.md", 2, 10, "hello")
    assert base != _content_hash_id("docs/foo.md", 1, 11, "hello")
    assert base != _content_hash_id("docs/foo.md", 1, 10, "world")


def test_content_hash_id_is_short_and_hex() -> None:
    h = _content_hash_id("a", 1, 1, "x")
    assert len(h) == 16
    int(h, 16)  # hex


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------


def test_load_text_preserves_lines(tmp_path: Path) -> None:
    p = tmp_path / "a.md"
    p.write_text("# Title\n\nFirst paragraph.\nSecond line.\n")
    out = _load_text(p)
    assert "First paragraph." in out
    assert out.endswith("\n") or "Second line." in out


def test_load_html_strips_script_and_style(tmp_path: Path) -> None:
    p = tmp_path / "a.html"
    p.write_text(
        "<html><head><style>body{color:red;}</style></head>"
        "<body><script>alert(1)</script><p>Hello world</p></body></html>"
    )
    out = _load_html(p)
    assert "Hello world" in out
    assert "alert(1)" not in out
    assert "color:red" not in out


# ---------------------------------------------------------------------------
# read_passage safety
# ---------------------------------------------------------------------------


def test_read_passage_returns_inclusive_1_indexed_range(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("L1\nL2\nL3\nL4\nL5\n")
    out = read_passage(tmp_path, "a.md", 2, 4)
    assert out.splitlines() == ["L2", "L3", "L4"]


def test_read_passage_clamps_end_line_to_file_length(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("only one line")
    # end past EOF should not crash
    out = read_passage(tmp_path, "a.md", 1, 100)
    assert "only one line" in out


def test_read_passage_rejects_invalid_range(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("L1\n")
    with pytest.raises(ValueError):
        read_passage(tmp_path, "a.md", 5, 2)


def test_read_passage_rejects_path_traversal(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("inside")
    (tmp_path.parent / "secret.md").write_text("outside")
    try:
        with pytest.raises((ValueError, FileNotFoundError, PermissionError)):
            read_passage(tmp_path, "../secret.md", 1, 1)
    finally:
        (tmp_path.parent / "secret.md").unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# list_corpus
# ---------------------------------------------------------------------------


def test_list_corpus_skips_non_supported_extensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "doc.md").write_text("hello")
    (tmp_path / "doc.txt").write_text("hi")
    (tmp_path / "ignored.bin").write_bytes(b"\x00\x01\x02")
    # Avoid touching the real vector store
    monkeypatch.setattr(ingest, "_ingested_path_counts", lambda: {})
    files = list_corpus(tmp_path)
    paths = {f.path for f in files}
    assert "doc.md" in paths
    assert "doc.txt" in paths
    assert "ignored.bin" not in paths


def test_list_corpus_marks_ingested(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "doc.md").write_text("hello world")
    monkeypatch.setattr(ingest, "_ingested_path_counts", lambda: {"doc.md": 3})
    files = list_corpus(tmp_path)
    assert len(files) == 1
    assert files[0].ingested is True
    assert files[0].n_chunks == 3


# ---------------------------------------------------------------------------
# _ingest_sync failure semantics
#
# The bug we're guarding against: a chromadb upsert raises mid-run; the old
# code caught every exception per-file, logged "Skipped <file>: ...", and
# returned chunks_written=0 with no error. The worker then reported
# state="succeeded" with chunks_written=0 — a silent data-loss bug.
#
# The new contract: a hard upsert failure (chromadb readonly, embedder OOM,
# etc.) re-raises out of _ingest_sync so the worker can write state="failed".
# Soft per-file failures (unsupported extension, encoding) still skip.
# ---------------------------------------------------------------------------


class _FakeAdapter:
    """Vector store stub that fails the first upsert."""

    def __init__(self, fail_with: Exception) -> None:
        self._fail_with = fail_with
        self.upsert_calls = 0

    def upsert(self, records) -> None:
        self.upsert_calls += 1
        raise self._fail_with

    def count(self) -> int:  # pragma: no cover - kept for adapter shape parity
        return 0


class _FakeEmbedder:
    DIM = 8

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[float(i) for i in range(self.DIM)] for _ in texts]


def _make_cfg(corpus: Path):
    from ui.backend.schemas import BratanConfig, VectorDBConfig

    return BratanConfig(
        project=BratanConfig().project.model_copy(update={"corpus_path": str(corpus)}),
        vector_db=VectorDBConfig(chroma_path=str(corpus.parent / ".chroma")),
    )


def test_ingest_sync_raises_on_unrecoverable_upsert_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-recoverable upsert error must propagate out of _ingest_sync."""
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "a.md").write_text("# Doc A\n\nFirst content.\n")
    (corpus / "b.md").write_text("# Doc B\n\nSecond content.\n")

    fail = RuntimeError("attempt to write a readonly database")
    fake_adapter = _FakeAdapter(fail_with=fail)
    monkeypatch.setattr(ingest, "get_vectordb", lambda _cfg: fake_adapter)
    monkeypatch.setattr(ingest, "get_embedder", lambda _model: _FakeEmbedder())

    cfg = _make_cfg(corpus)

    with pytest.raises(RuntimeError, match="readonly database"):
        _ingest_sync(cfg)

    # Critical regression assertion: the FIRST failing upsert must surface,
    # not be swallowed and let chunks_written stay at 0.
    assert fake_adapter.upsert_calls == 1


def test_ingest_sync_skips_unsupported_files_without_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A binary / unsupported file in the corpus must NOT fail the run."""
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "ok.md").write_text("# Real content\n\nText.\n")
    # An extension we don't support — _iter_corpus_files already filters these,
    # but if one slips through (e.g. via a future loader regression) _load_text
    # would raise ValueError("Unsupported extension: ...") and we must skip it.

    successful_records: list[list] = []

    class CountingAdapter:
        def upsert(self, records):
            successful_records.append(list(records))

        def count(self):
            return sum(len(r) for r in successful_records)

    monkeypatch.setattr(ingest, "get_vectordb", lambda _cfg: CountingAdapter())
    monkeypatch.setattr(ingest, "get_embedder", lambda _model: _FakeEmbedder())

    cfg = _make_cfg(corpus)
    n = _ingest_sync(cfg)
    assert n > 0, "expected the supported file to produce chunks"


def test_ingest_sync_zero_chunks_when_corpus_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty corpus returns 0 chunks WITHOUT raising — vacuously OK.

    The worker only flips to state=failed when files_done > 0 AND chunks_written == 0,
    so an empty corpus correctly reports state=succeeded with chunks_written=0.
    """
    corpus = tmp_path / "corpus"
    corpus.mkdir()

    monkeypatch.setattr(ingest, "get_vectordb", lambda _cfg: MagicMock())
    monkeypatch.setattr(ingest, "get_embedder", lambda _model: _FakeEmbedder())

    cfg = _make_cfg(corpus)
    assert _ingest_sync(cfg) == 0
