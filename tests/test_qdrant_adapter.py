"""Integration tests for the Qdrant adapter against an in-memory client.

Mirrors the Chroma adapter tests. Skipped cleanly when the optional
``qdrant-client`` dependency isn't installed.
"""

from __future__ import annotations

import pytest

pytest.importorskip("qdrant_client")

from pipeline.adapters.base import ChunkRecord
from pipeline.adapters.qdrant import (
    QdrantAdapter,
    _flatten_metadata,
    _point_id,
    _sparse_vectorize,
)


@pytest.fixture
def adapter() -> QdrantAdapter:
    # ":memory:" gives a hermetic, process-local client with no network IO.
    return QdrantAdapter(url=":memory:", api_key=None, collection="test_corpus")


def _chunk(id_: str, vec: list[float], **meta) -> ChunkRecord:
    return ChunkRecord(
        id=id_,
        text=meta.pop("text", f"chunk-{id_}"),
        embedding=vec,
        metadata={"path": "a.md", "start_line": 1, "end_line": 5, **meta},
    )


# 16-hex-char ids matching the content-hash scheme the pipeline uses.
# We vary the *prefix*: _point_id() folds the first 15 chars into the numeric
# id, so the prefix is what guarantees uniqueness on the wire.
def _hex_id(prefix: str) -> str:
    return prefix + ("0" * (16 - len(prefix)))


def test_upsert_then_count(adapter: QdrantAdapter) -> None:
    assert adapter.count() == 0
    adapter.upsert([_chunk(_hex_id("a"), [1.0, 0.0]), _chunk(_hex_id("b"), [0.0, 1.0])])
    assert adapter.count() == 2


def test_upsert_is_idempotent(adapter: QdrantAdapter) -> None:
    cid = _hex_id("a")
    adapter.upsert([_chunk(cid, [1.0, 0.0])])
    adapter.upsert([_chunk(cid, [1.0, 0.0])])
    assert adapter.count() == 1


def test_vector_query_orders_by_similarity(adapter: QdrantAdapter) -> None:
    adapter.upsert(
        [
            _chunk(_hex_id("a"), [1.0, 0.0, 0.0]),   # identical to query
            _chunk(_hex_id("b"), [0.0, 1.0, 0.0]),   # orthogonal
            _chunk(_hex_id("c"), [-1.0, 0.0, 0.0]),  # opposite
        ]
    )
    hits = adapter.vector_query([1.0, 0.0, 0.0], k=3)
    assert [h.id for h in hits] == [_hex_id("a"), _hex_id("b"), _hex_id("c")]
    # Qdrant returns raw cosine similarity: ~1.0 for identical, ~-1 for opposite.
    assert hits[0].score == pytest.approx(1.0, abs=1e-5)
    assert hits[-1].score < 0.0


def test_vector_query_respects_k(adapter: QdrantAdapter) -> None:
    adapter.upsert(
        [_chunk(_hex_id(c), [float(i + 1), 0.0]) for i, c in enumerate("abcd")]
    )
    hits = adapter.vector_query([1.0, 0.0], k=2)
    assert len(hits) == 2


def test_metadata_round_trips(adapter: QdrantAdapter) -> None:
    cid = _hex_id("a")
    adapter.upsert([_chunk(cid, [1.0, 0.0], path="doc.md", start_line=42, end_line=58)])
    hit = adapter.vector_query([1.0, 0.0], k=1)[0]
    assert hit.id == cid
    assert hit.metadata["path"] == "doc.md"
    assert hit.metadata["start_line"] == 42
    assert hit.metadata["end_line"] == 58
    # chunk_id and text must not leak into metadata — they live on QueryHit itself.
    assert "chunk_id" not in hit.metadata
    assert "text" not in hit.metadata


def test_delete_removes_only_specified(adapter: QdrantAdapter) -> None:
    a, b = _hex_id("a"), _hex_id("b")
    adapter.upsert([_chunk(a, [1.0, 0.0]), _chunk(b, [0.0, 1.0])])
    adapter.delete([a])
    assert adapter.count() == 1
    remaining = adapter.vector_query([0.0, 1.0], k=5)
    assert {h.id for h in remaining} == {b}


def test_hybrid_query_returns_none_before_ingest(adapter: QdrantAdapter) -> None:
    """Before any upsert the collection doesn't exist, so hybrid has nothing
    to score against. We surface that as ``None`` (caller can fall back) rather
    than as an empty list — matches the documented contract on the base class.
    """
    assert adapter.hybrid_query_if_supported("anything", [1.0, 0.0], 5) is None


def test_hybrid_query_returns_hits(adapter: QdrantAdapter) -> None:
    """End-to-end smoke of native dense + sparse RRF fusion.

    We upsert 5 chunks whose *text* and *embeddings* both line up with the
    query in different ways, then assert the fused ranking surfaces at
    least one hit. RRF is rank-based so exact scores aren't pinned, but the
    presence of a result is enough to prove both lanes wired through.
    """
    # Vary text so the sparse lane has something to score on; vary embeddings
    # so the dense lane has signal too. The "alpha" chunk is the closest match
    # for the query "alpha keyword" on both lanes.
    chunks = [
        _chunk(_hex_id("a"), [1.0, 0.0, 0.0], text="alpha keyword matters here"),
        _chunk(_hex_id("b"), [0.9, 0.1, 0.0], text="beta beta beta something else"),
        _chunk(_hex_id("c"), [0.0, 1.0, 0.0], text="gamma totally unrelated content"),
        _chunk(_hex_id("d"), [0.0, 0.0, 1.0], text="delta yet more unrelated text"),
        _chunk(_hex_id("e"), [-1.0, 0.0, 0.0], text="epsilon final chunk no match"),
    ]
    adapter.upsert(chunks)
    hits = adapter.hybrid_query_if_supported(
        text="alpha keyword",
        embedding=[1.0, 0.0, 0.0],
        k=3,
    )
    assert hits is not None
    assert len(hits) >= 1
    # The "alpha" chunk wins on both lanes; RRF should put it first.
    assert hits[0].id == _hex_id("a")


def test_hybrid_falls_back_when_sparse_empty(adapter: QdrantAdapter) -> None:
    """When the query has zero sparse-vocab overlap (e.g. all stop-words or
    pure whitespace), the sparse lane returns nothing useful, but the dense
    prefetch still feeds RRF — so hybrid retrieval keeps working.
    """
    adapter.upsert(
        [
            _chunk(_hex_id("a"), [1.0, 0.0, 0.0], text="alpha"),
            _chunk(_hex_id("b"), [0.0, 1.0, 0.0], text="beta"),
        ]
    )
    # Empty string -> empty sparse vector; dense lane carries the result.
    hits = adapter.hybrid_query_if_supported(
        text="   ",
        embedding=[1.0, 0.0, 0.0],
        k=2,
    )
    assert hits is not None
    assert len(hits) >= 1
    # Dense match should still bubble the aligned chunk to the top.
    assert hits[0].id == _hex_id("a")


def test_sparse_vectorize_produces_nonempty_for_seed_corpus() -> None:
    """Sanity check that the BM25-shape vectorizer produces sensible output.

    Specifically: non-empty for non-empty text, empty for empty text, and
    weights monotone in term frequency (1+log(tf)).
    """
    empty = _sparse_vectorize("")
    assert empty == {}

    out = _sparse_vectorize("hybrid retrieval combines dense and sparse signals")
    assert isinstance(out, dict)
    assert len(out) >= 6  # ~7 distinct tokens (case-insensitive)
    assert all(isinstance(idx, int) and v > 0.0 for idx, v in out.items())

    # Repeated tokens should get higher weight than singletons.
    singleton = _sparse_vectorize("apple")
    repeated = _sparse_vectorize("apple apple apple")
    # Same bucket for "apple" both times -> deterministic, comparable.
    assert set(singleton.keys()) == set(repeated.keys())
    [(idx, w1)] = singleton.items()
    assert repeated[idx] > w1


def test_health_check_ok(adapter: QdrantAdapter) -> None:
    out = adapter.health_check()
    assert out.ok is True
    assert out.latency_ms is not None and out.latency_ms >= 0
    assert out.detail["collection"] == "test_corpus"


def test_count_before_first_upsert_is_zero(adapter: QdrantAdapter) -> None:
    # Collection is created lazily — count must work before any upsert.
    assert adapter.count() == 0


def test_vector_query_before_upsert_is_empty(adapter: QdrantAdapter) -> None:
    assert adapter.vector_query([1.0, 0.0], k=5) == []


def test_point_id_is_stable_and_in_range() -> None:
    cid = "abcdef0123456789"
    assert _point_id(cid) == _point_id(cid)
    assert 0 <= _point_id(cid) < (1 << 64)


def test_flatten_metadata_coerces_non_scalars() -> None:
    flat = _flatten_metadata({"s": "x", "n": 1, "b": True, "lst": [1, 2], "none": None})
    assert flat["s"] == "x"
    assert flat["n"] == 1
    assert flat["b"] is True
    assert flat["none"] is None
    assert isinstance(flat["lst"], str)
