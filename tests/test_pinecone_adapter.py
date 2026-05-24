"""Tests for the Pinecone adapter.

Pinecone has no in-memory mode, so we drive the adapter against a recording
mock of the ``pinecone`` SDK. The mock pins the wire shape: argument names,
batch sizes, the include_metadata flag, etc. — so a future SDK schema break
shows up here instead of in a production smoke test.

Skipped cleanly when the optional ``pinecone`` package isn't installed.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("pinecone")

from pipeline.adapters.base import ChunkRecord
from pipeline.adapters.pinecone import (
    _UPSERT_BATCH,
    PineconeAdapter,
    _flatten_metadata,
    _hit_from_match,
    _matches,
    _stats_total,
)


def _chunk(id_: str, vec: list[float], **meta) -> ChunkRecord:
    return ChunkRecord(
        id=id_,
        text=meta.pop("text", f"chunk-{id_}"),
        embedding=vec,
        metadata={"path": "a.md", "start_line": 1, "end_line": 5, **meta},
    )


class _FakeIndex:
    """Records every SDK call so tests can assert on the wire shape."""

    def __init__(self) -> None:
        self.upserts: list[dict] = []
        self.deletes: list[dict] = []
        self.queries: list[dict] = []
        self.vectors: dict[str, dict] = {}

    def upsert(self, vectors=None, namespace=None):
        self.upserts.append({"vectors": vectors, "namespace": namespace})
        for v in vectors or []:
            self.vectors[v["id"]] = v

    def delete(self, ids=None, namespace=None):
        self.deletes.append({"ids": ids, "namespace": namespace})
        for cid in ids or []:
            self.vectors.pop(cid, None)

    def query(self, vector=None, top_k=None, include_metadata=None, namespace=None):
        self.queries.append(
            {
                "vector": vector,
                "top_k": top_k,
                "include_metadata": include_metadata,
                "namespace": namespace,
            }
        )

        # Cosine-similarity ranking against stored vectors, just enough to
        # exercise scoring logic in tests without doing real ANN.
        def _cos(a, b):
            num = sum(x * y for x, y in zip(a, b, strict=False))
            da = sum(x * x for x in a) ** 0.5 or 1.0
            db = sum(y * y for y in b) ** 0.5 or 1.0
            return num / (da * db)

        scored = [
            SimpleNamespace(
                id=v["id"],
                score=_cos(vector, v["values"]),
                metadata=v.get("metadata") or {},
            )
            for v in self.vectors.values()
        ]
        scored.sort(key=lambda m: m.score, reverse=True)
        matches = scored[: top_k or 1]
        return SimpleNamespace(matches=matches)

    def describe_index_stats(self):
        return SimpleNamespace(total_vector_count=len(self.vectors))


class _FakeClient:
    def __init__(self, *, has_index: bool = False) -> None:
        self._has_index = has_index
        self.index = _FakeIndex()
        self.create_index_calls: list[dict] = []
        self.list_index_calls = 0

    def list_indexes(self):
        self.list_index_calls += 1
        return [SimpleNamespace(name="bratan-idx")] if self._has_index else []

    def create_index(self, name, dimension, metric, spec):
        self.create_index_calls.append(
            {"name": name, "dimension": dimension, "metric": metric, "spec": spec}
        )
        self._has_index = True

    def Index(self, name):
        return self.index


@pytest.fixture
def fake_client():
    return _FakeClient()


@pytest.fixture
def adapter(fake_client):
    with patch("pinecone.Pinecone", return_value=fake_client):
        yield PineconeAdapter(api_key="k", index_name="bratan-idx")


def test_constructor_requires_api_key():
    with pytest.raises(ValueError, match="api_key"):
        PineconeAdapter(api_key="", index_name="x")


def test_constructor_requires_index_name():
    with pytest.raises(ValueError, match="index_name"):
        PineconeAdapter(api_key="k", index_name="")


def test_upsert_creates_index_on_first_write(adapter, fake_client):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    assert len(fake_client.create_index_calls) == 1
    call = fake_client.create_index_calls[0]
    assert call["name"] == "bratan-idx"
    assert call["dimension"] == 2
    assert call["metric"] == "cosine"


def test_upsert_skips_index_create_when_already_exists():
    client = _FakeClient(has_index=True)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        a.upsert([_chunk("a", [1.0, 0.0])])
    assert client.create_index_calls == []


def test_upsert_passes_id_and_text_in_metadata(adapter, fake_client):
    adapter.upsert([_chunk("abc", [1.0, 0.0], path="doc.md", start_line=42)])
    sent = fake_client.index.upserts[-1]["vectors"][0]
    assert sent["id"] == "abc"
    assert sent["values"] == [1.0, 0.0]
    # text is folded into metadata so Pinecone can return it (vectors only
    # round-trip metadata, not "documents").
    assert sent["metadata"]["text"] == "chunk-abc"
    assert sent["metadata"]["path"] == "doc.md"
    assert sent["metadata"]["start_line"] == 42


def test_upsert_batches_at_pinecone_limit(adapter, fake_client):
    items = [_chunk(f"{i:016x}", [float(i), 0.0]) for i in range(_UPSERT_BATCH + 5)]
    adapter.upsert(items)
    # First call exists (the index-create call) followed by N batches.
    batches = [c["vectors"] for c in fake_client.index.upserts]
    assert [len(b) for b in batches] == [_UPSERT_BATCH, 5]


def test_vector_query_returns_hits_in_order(adapter):
    adapter.upsert(
        [
            _chunk("a", [1.0, 0.0]),  # identical
            _chunk("b", [0.0, 1.0]),  # orthogonal
        ]
    )
    hits = adapter.vector_query([1.0, 0.0], k=2)
    assert [h.id for h in hits] == ["a", "b"]
    assert hits[0].score == pytest.approx(1.0, abs=1e-5)


def test_vector_query_includes_metadata_flag(adapter, fake_client):
    adapter.upsert([_chunk("a", [1.0, 0.0])])
    adapter.vector_query([1.0, 0.0], k=1)
    q = fake_client.index.queries[-1]
    assert q["include_metadata"] is True
    assert q["top_k"] == 1


def test_vector_query_when_index_missing_returns_empty():
    # No upsert -> no index -> no query call.
    client = _FakeClient(has_index=False)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        assert a.vector_query([1.0, 0.0], k=5) == []
    assert client.index.queries == []


def test_hybrid_query_returns_none(adapter):
    assert adapter.hybrid_query_if_supported("anything", [1.0, 0.0], 5) is None


def test_delete_calls_pinecone(adapter, fake_client):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    adapter.delete(["a"])
    assert fake_client.index.deletes[-1]["ids"] == ["a"]
    assert adapter.count() == 1


def test_delete_noop_before_index_exists():
    client = _FakeClient(has_index=False)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        a.delete(["a", "b"])
    assert client.index.deletes == []


def test_count_zero_before_first_upsert():
    client = _FakeClient(has_index=False)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        assert a.count() == 0


def test_count_returns_total_after_upsert(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    assert adapter.count() == 2


def test_health_check_ok(adapter):
    out = adapter.health_check()
    assert out.ok is True
    assert out.latency_ms is not None and out.latency_ms >= 0
    assert out.detail["index"] == "bratan-idx"
    # Index doesn't exist yet -> exists False, no count.
    assert out.detail["exists"] is False


def test_health_check_includes_count_when_index_exists():
    client = _FakeClient(has_index=True)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        a.upsert([_chunk("a", [1.0, 0.0])])
        out = a.health_check()
    assert out.ok is True
    assert out.detail["exists"] is True
    assert out.detail["count"] == 1


def test_health_check_handles_sdk_error():
    client = MagicMock()
    client.list_indexes.side_effect = RuntimeError("boom")
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(api_key="k", index_name="bratan-idx")
        out = a.health_check()
    assert out.ok is False
    assert "boom" in (out.error or "")


def test_namespace_propagates():
    client = _FakeClient(has_index=True)
    with patch("pinecone.Pinecone", return_value=client):
        a = PineconeAdapter(
            api_key="k", index_name="bratan-idx", namespace="tenant-1"
        )
        a.upsert([_chunk("a", [1.0, 0.0])])
        a.vector_query([1.0, 0.0], k=1)
        a.delete(["a"])
    assert client.index.upserts[-1]["namespace"] == "tenant-1"
    assert client.index.queries[-1]["namespace"] == "tenant-1"
    assert client.index.deletes[-1]["namespace"] == "tenant-1"


def test_flatten_metadata_drops_none_and_stringifies_complex():
    flat = _flatten_metadata({"s": "x", "n": 1, "b": True, "lst": ["a"], "x": None, "d": {"k": "v"}})
    assert flat["s"] == "x"
    assert flat["n"] == 1
    assert flat["b"] is True
    assert flat["lst"] == ["a"]  # list[str] preserved
    assert "x" not in flat  # None dropped — Pinecone rejects it
    assert isinstance(flat["d"], str)


def test_matches_handles_attr_and_dict_forms():
    # SDK returns objects with .matches.
    obj = SimpleNamespace(matches=[SimpleNamespace(id="a", score=0.9, metadata={"text": "t"})])
    out = _matches(obj)
    assert len(out) == 1
    # Older SDKs return dicts.
    out = _matches({"matches": [{"id": "a", "score": 0.5, "metadata": {"text": "t"}}]})
    assert len(out) == 1


def test_hit_from_match_extracts_text_from_metadata():
    m = SimpleNamespace(id="a", score=0.9, metadata={"text": "hello", "path": "p.md"})
    hit = _hit_from_match(m)
    assert hit.id == "a"
    assert hit.text == "hello"
    assert hit.metadata == {"path": "p.md"}


def test_stats_total_handles_attr_and_dict_forms():
    assert _stats_total(SimpleNamespace(total_vector_count=7)) == 7
    assert _stats_total({"total_vector_count": 7}) == 7
    assert _stats_total(object()) == 0
