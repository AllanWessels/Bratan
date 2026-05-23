"""Integration tests for the ChromaDB adapter against a real on-disk client.

Chroma's persistent client is cheap; using a tmp_path-backed collection keeps
these tests hermetic without needing an in-memory adapter.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline.adapters.base import ChunkRecord
from pipeline.adapters.chroma import ChromaAdapter, _flatten_metadata


@pytest.fixture
def adapter(tmp_path: Path) -> ChromaAdapter:
    return ChromaAdapter(path=tmp_path / "chroma", collection="test_corpus")


def _chunk(id_: str, vec: list[float], **meta) -> ChunkRecord:
    return ChunkRecord(
        id=id_,
        text=meta.pop("text", f"chunk-{id_}"),
        embedding=vec,
        metadata={"path": "a.md", "start_line": 1, "end_line": 5, **meta},
    )


def test_upsert_then_count(adapter: ChromaAdapter) -> None:
    assert adapter.count() == 0
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    assert adapter.count() == 2


def test_upsert_is_idempotent(adapter: ChromaAdapter) -> None:
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    assert adapter.count() == 1


def test_vector_query_orders_by_similarity(adapter: ChromaAdapter) -> None:
    adapter.upsert(
        [
            _chunk("a", [1.0, 0.0, 0.0]),  # identical to query
            _chunk("b", [0.0, 1.0, 0.0]),  # orthogonal
            _chunk("c", [-1.0, 0.0, 0.0]),  # opposite
        ]
    )
    hits = adapter.vector_query([1.0, 0.0, 0.0], k=3)
    assert [h.id for h in hits] == ["a", "b", "c"]
    # cosine: score for identical vector is ~1.0, opposite is ~-1
    assert hits[0].score == pytest.approx(1.0, abs=1e-5)
    assert hits[-1].score < 0.0


def test_vector_query_respects_k(adapter: ChromaAdapter) -> None:
    adapter.upsert([_chunk(c, [float(i + 1), 0.0]) for i, c in enumerate("abcd")])
    hits = adapter.vector_query([1.0, 0.0], k=2)
    assert len(hits) == 2


def test_metadata_round_trips(adapter: ChromaAdapter) -> None:
    adapter.upsert([_chunk("a", [1.0, 0.0], path="doc.md", start_line=42, end_line=58)])
    hit = adapter.vector_query([1.0, 0.0], k=1)[0]
    assert hit.metadata["path"] == "doc.md"
    assert hit.metadata["start_line"] == 42
    assert hit.metadata["end_line"] == 58


def test_delete_removes_only_specified(adapter: ChromaAdapter) -> None:
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    adapter.delete(["a"])
    assert adapter.count() == 1
    remaining = adapter.vector_query([0.0, 1.0], k=5)
    assert {h.id for h in remaining} == {"b"}


def test_hybrid_query_returns_none(adapter: ChromaAdapter) -> None:
    """ChromaDB has no native BM25; adapter must say so explicitly."""
    assert adapter.hybrid_query_if_supported("anything", [1.0, 0.0], 5) is None


def test_health_check_ok(adapter: ChromaAdapter) -> None:
    out = adapter.health_check()
    assert out.ok is True
    assert out.latency_ms is not None and out.latency_ms >= 0
    assert out.detail["count"] == 0
    assert out.detail["collection"] == "test_corpus"


def test_flatten_metadata_coerces_non_scalars() -> None:
    flat = _flatten_metadata({"s": "x", "n": 1, "b": True, "lst": [1, 2], "none": None})
    assert flat["s"] == "x"
    assert flat["n"] == 1
    assert flat["b"] is True
    assert flat["none"] is None
    # lists/dicts get coerced to strings (Chroma constraint)
    assert isinstance(flat["lst"], str)
