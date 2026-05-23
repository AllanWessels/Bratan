"""Tests for pipeline.ingest — chunker invariants, loaders, read_passage safety, content-hash IDs."""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline import ingest
from pipeline.ingest import (
    _Chunk,
    _chunk_text,
    _content_hash_id,
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
