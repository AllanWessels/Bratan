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


# ---------------------------------------------------------------------------
# Recovery — regression for the "no such table: tenants" error the user hit
# when the .chroma dir got wiped under a stale chromadb client.
# ---------------------------------------------------------------------------


def test_with_recovery_only_swallows_recoverable_errors(adapter: ChromaAdapter) -> None:
    def boom_unrecoverable() -> None:
        raise RuntimeError("totally unrelated bug")

    with pytest.raises(RuntimeError, match="totally unrelated"):
        adapter._with_recovery(boom_unrecoverable)


def test_with_recovery_recognizes_no_such_table(adapter: ChromaAdapter) -> None:
    """The exact error string the user hit must be classified recoverable."""
    from pipeline.adapters.chroma import _RECOVERABLE_MARKERS

    err = "Database error: error returned from database: (code: 1) no such table: tenants"
    assert any(marker in err for marker in _RECOVERABLE_MARKERS)


def test_with_recovery_recognizes_readonly_database(adapter: ChromaAdapter) -> None:
    """The follow-on error (when the on-disk dir vanishes) is also recoverable."""
    from pipeline.adapters.chroma import _RECOVERABLE_MARKERS

    err = "Database error: error returned from database: (code: 1032) attempt to write a readonly database"
    assert any(marker in err for marker in _RECOVERABLE_MARKERS)


def test_with_recovery_recognizes_hnsw_segment_missing(adapter: ChromaAdapter) -> None:
    """Regression: user's HTTP 500 on corpus search after .chroma was wiped.

    The exact error: chromadb returned 'Internal error: Error creating hnsw segment
    reader: Nothing found on disk' because the SQLite metadata still pointed at
    HNSW segment files that no longer existed on disk. Must be classified
    recoverable so the adapter can re-init from a clean slate.
    """
    from pipeline.adapters.chroma import _RECOVERABLE_MARKERS

    err = (
        "Error executing plan: Internal error: Error creating hnsw segment "
        "reader: Nothing found on disk"
    )
    assert any(marker in err for marker in _RECOVERABLE_MARKERS)


def test_health_check_goes_through_recovery_wrapper(
    adapter: ChromaAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: the Step 2 "Test connection" button surfaced raw chromadb
    errors because health_check called self._collection.count() directly,
    bypassing _with_recovery. It must use self.count() so recoverable errors
    are handled and the user sees ok=true on a fresh collection."""

    state = {"raw_calls": 0}

    real_count = adapter._collection.count

    def boom_once_then_ok():
        state["raw_calls"] += 1
        if state["raw_calls"] == 1:
            raise Exception(
                "Database error: error returned from database: (code: 1) no such table: tenants"
            )
        return real_count()

    monkeypatch.setattr(adapter._collection, "count", boom_once_then_ok)
    # Pretend recovery succeeds (don't actually nuke chromadb's Rust state).
    monkeypatch.setattr(adapter, "_recover", lambda: None)

    result = adapter.health_check()
    assert result.ok is True
    assert state["raw_calls"] >= 2  # retried after recovery


def test_vector_query_returns_empty_after_segment_loss(
    adapter: ChromaAdapter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When chromadb raises the HNSW-segment-missing error, vector_query
    must return [] (not 500). Regression for the HTTP 500 the user saw on
    corpus search after .chroma was wiped under a live client.

    We inject the exact error chromadb produced via the underlying query
    bindings since the in-process recovery flow can't naturally trigger it
    (chromadb's Rust bindings keep some state cached even when the on-disk
    HNSW files vanish)."""

    # Make the underlying collection.query raise the user's exact error string.
    state = {"called": 0}

    real_query = adapter._collection.query

    def boom_then_empty(**kwargs):
        state["called"] += 1
        if state["called"] == 1:
            raise Exception(
                "Error executing plan: Internal error: Error creating hnsw "
                "segment reader: Nothing found on disk"
            )
        return real_query(**kwargs)

    monkeypatch.setattr(adapter._collection, "query", boom_then_empty)
    # Pretend recovery succeeds and leaves the adapter pointing at an empty
    # collection (which is what happens when _recover nukes the path).
    monkeypatch.setattr(adapter, "_recover", lambda: None)
    monkeypatch.setattr(adapter, "count", lambda: 0)

    # vector_query must return [] gracefully, NOT raise.
    hits = adapter.vector_query([1.0, 0.0], k=3)
    assert hits == []


def test_with_recovery_retries_then_succeeds(adapter: ChromaAdapter) -> None:
    """A recoverable error followed by success must return the success value."""
    state = {"calls": 0}

    def boom_once_then_ok() -> int:
        state["calls"] += 1
        if state["calls"] == 1:
            raise Exception("no such table: tenants")
        return 99

    # Patch _recover so we don't actually nuke the path (chromadb's Rust
    # bindings hold global state that we can't reset cleanly in-process).
    adapter._recover = lambda: None  # type: ignore[method-assign]
    out = adapter._with_recovery(boom_once_then_ok)
    assert out == 99
    assert state["calls"] == 2
