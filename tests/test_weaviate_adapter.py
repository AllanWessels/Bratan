"""Tests for the Weaviate adapter.

Weaviate's embedded mode requires a Java runtime and an actual server
download, so for hermetic unit tests we drive the adapter against a
recording mock of the v4 collections API. The mock pins the wire shape:
collection creation properties, DataObject layout, the near_vector vs
hybrid call surface — so a future SDK schema break shows up here.

Skipped cleanly when the optional ``weaviate-client`` package isn't
installed.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("weaviate")

from pipeline.adapters.base import ChunkRecord
from pipeline.adapters.weaviate import (
    WeaviateAdapter,
    _flatten_metadata,
    _hit_from_object,
    _uuid_for,
)


def _chunk(id_: str, vec: list[float], **meta) -> ChunkRecord:
    return ChunkRecord(
        id=id_,
        text=meta.pop("text", f"chunk-{id_}"),
        embedding=vec,
        metadata={"path": "a.md", "start_line": 1, "end_line": 5, **meta},
    )


class _FakeAggregate:
    def __init__(self, total: int) -> None:
        self.total_count = total


class _FakeAggregateQuery:
    def __init__(self, store):
        self._store = store

    def over_all(self, total_count=True):
        return _FakeAggregate(len(self._store))


class _FakeQuery:
    def __init__(self, store):
        self._store = store
        self.near_vector_calls: list[dict] = []
        self.hybrid_calls: list[dict] = []

    def near_vector(self, near_vector, limit, return_metadata):
        self.near_vector_calls.append(
            {"near_vector": near_vector, "limit": limit, "return_metadata": return_metadata}
        )

        def _cos(a, b):
            num = sum(x * y for x, y in zip(a, b, strict=False))
            da = sum(x * x for x in a) ** 0.5 or 1.0
            db = sum(y * y for y in b) ** 0.5 or 1.0
            return num / (da * db)

        ranked = [
            (uid, obj, 1.0 - _cos(near_vector, obj["vector"]))  # cosine distance
            for uid, obj in self._store.items()
        ]
        ranked.sort(key=lambda r: r[2])  # smaller distance == better
        objs = [
            SimpleNamespace(
                uuid=uid,
                properties=obj["properties"],
                metadata=SimpleNamespace(distance=dist, score=None),
            )
            for uid, obj, dist in ranked[:limit]
        ]
        return SimpleNamespace(objects=objs)

    def hybrid(self, query, vector, alpha, limit, return_metadata):
        self.hybrid_calls.append(
            {
                "query": query,
                "vector": vector,
                "alpha": alpha,
                "limit": limit,
                "return_metadata": return_metadata,
            }
        )
        # Cheap: return everything with score 1.0 in insertion order.
        objs = [
            SimpleNamespace(
                uuid=uid,
                properties=obj["properties"],
                metadata=SimpleNamespace(score=1.0, distance=None),
            )
            for uid, obj in list(self._store.items())[:limit]
        ]
        return SimpleNamespace(objects=objs)


class _FakeData:
    def __init__(self, store):
        self._store = store
        self.insert_many_calls: list[list] = []
        self.delete_calls: list[str] = []

    def insert_many(self, objects):
        self.insert_many_calls.append(objects)
        for obj in objects:
            self._store[str(obj.uuid)] = {
                "vector": obj.vector,
                "properties": dict(obj.properties),
            }

    def delete_by_id(self, uuid):
        self.delete_calls.append(str(uuid))
        self._store.pop(str(uuid), None)


class _FakeCollection:
    def __init__(self):
        self.store: dict[str, dict] = {}
        self.data = _FakeData(self.store)
        self.query = _FakeQuery(self.store)
        self.aggregate = _FakeAggregateQuery(self.store)


class _FakeCollections:
    def __init__(self):
        self._collections: dict[str, _FakeCollection] = {}
        self.create_calls: list[dict] = []

    def exists(self, name):
        return name in self._collections

    def get(self, name):
        return self._collections[name]

    def create(self, name, vectorizer_config, vector_index_config, properties):
        self.create_calls.append(
            {
                "name": name,
                "vectorizer_config": vectorizer_config,
                "vector_index_config": vector_index_config,
                "properties": properties,
            }
        )
        self._collections[name] = _FakeCollection()


class _FakeClient:
    def __init__(self):
        self.collections = _FakeCollections()
        self.closed = False

    def is_ready(self):
        return True

    def close(self):
        self.closed = True


@pytest.fixture
def fake_client():
    return _FakeClient()


@pytest.fixture
def adapter(fake_client):
    with patch("weaviate.connect_to_local", return_value=fake_client):
        yield WeaviateAdapter(url="http://localhost:8080", collection="Bratan")


def test_constructor_requires_url():
    with pytest.raises(ValueError, match="url"):
        WeaviateAdapter(url="", api_key=None)


def test_constructor_picks_local_for_localhost(fake_client):
    with patch("weaviate.connect_to_local", return_value=fake_client) as m:
        WeaviateAdapter(url="http://localhost:8080")
    m.assert_called_once()
    assert m.call_args.kwargs["host"] == "localhost"
    assert m.call_args.kwargs["port"] == 8080


def test_constructor_picks_cloud_for_weaviate_network(fake_client):
    with patch("weaviate.connect_to_weaviate_cloud", return_value=fake_client) as m:
        WeaviateAdapter(url="https://my-cluster.weaviate.network", api_key="k")
    m.assert_called_once()


def test_cloud_requires_api_key():
    with pytest.raises(ValueError, match="api_key"):
        WeaviateAdapter(url="https://my-cluster.weaviate.network")


def test_upsert_creates_collection_on_first_write(adapter, fake_client):
    adapter.upsert([_chunk("abcdef0000000001", [1.0, 0.0])])
    assert len(fake_client.collections.create_calls) == 1
    call = fake_client.collections.create_calls[0]
    assert call["name"] == "Bratan"
    prop_names = [p.name for p in call["properties"]]
    assert prop_names == ["chunk_id", "text", "path", "start_line", "end_line"]


def test_upsert_writes_properties_and_vector(adapter, fake_client):
    cid = "abcdef0000000001"
    adapter.upsert([_chunk(cid, [1.0, 0.0], path="doc.md", start_line=42)])
    coll = fake_client.collections.get("Bratan")
    obj = next(iter(coll.store.values()))
    assert obj["vector"] == [1.0, 0.0]
    assert obj["properties"]["chunk_id"] == cid
    assert obj["properties"]["text"] == f"chunk-{cid}"
    assert obj["properties"]["path"] == "doc.md"
    assert obj["properties"]["start_line"] == 42


def test_vector_query_ranks_by_similarity(adapter):
    adapter.upsert(
        [
            _chunk("a", [1.0, 0.0]),  # identical
            _chunk("b", [0.0, 1.0]),  # orthogonal
        ]
    )
    hits = adapter.vector_query([1.0, 0.0], k=2)
    assert [h.id for h in hits] == ["a", "b"]
    assert hits[0].score == pytest.approx(1.0, abs=1e-5)


def test_vector_query_excludes_chunk_id_and_text_from_metadata(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0], path="doc.md")])
    hit = adapter.vector_query([1.0, 0.0], k=1)[0]
    assert hit.id == "a"
    assert hit.text == "chunk-a"
    assert "chunk_id" not in hit.metadata
    assert "text" not in hit.metadata
    assert hit.metadata["path"] == "doc.md"


def test_hybrid_query_returns_results_with_alpha(adapter, fake_client):
    """Weaviate's native hybrid is the whole reason this adapter exists."""
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    hits = adapter.hybrid_query_if_supported("anything", [1.0, 0.0], k=2)
    assert hits is not None
    assert len(hits) == 2
    call = fake_client.collections.get("Bratan").query.hybrid_calls[-1]
    assert call["query"] == "anything"
    assert call["alpha"] == 0.5
    assert call["limit"] == 2


def test_hybrid_query_empty_before_first_upsert(adapter):
    out = adapter.hybrid_query_if_supported("q", [1.0, 0.0], 5)
    # Returns empty list (not None) so callers see "supported but empty".
    assert out == []


def test_delete_removes_specified(adapter, fake_client):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    adapter.delete(["a"])
    assert adapter.count() == 1


def test_count_zero_before_first_upsert(adapter):
    assert adapter.count() == 0


def test_count_after_upsert(adapter):
    adapter.upsert([_chunk("a", [1.0, 0.0]), _chunk("b", [0.0, 1.0])])
    assert adapter.count() == 2


def test_health_check_ok(adapter):
    out = adapter.health_check()
    assert out.ok is True
    assert out.latency_ms is not None and out.latency_ms >= 0
    assert out.detail["collection"] == "Bratan"


def test_health_check_handles_sdk_error():
    bad_client = MagicMock()
    bad_client.collections.exists.return_value = False
    bad_client.is_ready.side_effect = RuntimeError("boom")
    with patch("weaviate.connect_to_local", return_value=bad_client):
        a = WeaviateAdapter(url="http://localhost:8080")
        out = a.health_check()
    assert out.ok is False
    assert "boom" in (out.error or "")


def test_close_releases_client(adapter, fake_client):
    adapter.close()
    assert fake_client.closed is True


def test_flatten_metadata_coerces_non_scalars():
    flat = _flatten_metadata({"s": "x", "n": 1, "b": True, "lst": [1, 2], "none": None})
    assert flat["s"] == "x"
    assert flat["n"] == 1
    assert flat["b"] is True
    assert flat["none"] is None
    assert isinstance(flat["lst"], str)


def test_uuid_for_is_stable():
    a = _uuid_for("abc")
    b = _uuid_for("abc")
    assert a == b
    assert a != _uuid_for("abd")


def test_hit_from_object_handles_score_path():
    obj = SimpleNamespace(
        uuid="u",
        properties={"chunk_id": "a", "text": "hi", "path": "p.md"},
        metadata=SimpleNamespace(score=0.7, distance=None),
    )
    hit = _hit_from_object(obj, score_from="score")
    assert hit.id == "a"
    assert hit.text == "hi"
    assert hit.score == pytest.approx(0.7)
    assert hit.metadata == {"path": "p.md"}


def test_hit_from_object_handles_distance_path():
    obj = SimpleNamespace(
        uuid="u",
        properties={"chunk_id": "a", "text": "hi"},
        metadata=SimpleNamespace(score=None, distance=0.2),
    )
    hit = _hit_from_object(obj, score_from="distance")
    assert hit.score == pytest.approx(0.8)
