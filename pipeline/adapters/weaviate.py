"""Weaviate adapter — local or cloud, with native hybrid retrieval.

Weaviate's headline advantage over Chroma / Qdrant / Pinecone in this lineup
is that its ``query.hybrid`` operator does the BM25 + vector fusion for us,
so ``hybrid_query_if_supported`` actually returns hits instead of None.
"""

from __future__ import annotations

import contextlib
import logging
import time
from typing import Any
from urllib.parse import urlparse

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)


class WeaviateAdapter(VectorDBAdapter):
    """Weaviate v4 collections-API adapter.

    Picks ``connect_to_local`` for ``http(s)://host:port`` URLs targeting
    self-hosted Weaviate and ``connect_to_weaviate_cloud`` for cluster URLs
    that look like ``*.weaviate.network``. The collection is auto-created on
    first upsert with cosine distance and properties matching the rest of
    the pipeline (chunk_id, text, path, start_line, end_line).
    """

    def __init__(
        self,
        url: str,
        api_key: str | None = None,
        collection: str = "Bratan",
    ) -> None:
        if not url:
            raise ValueError("Weaviate url is required.")
        # Local import keeps the optional dep truly optional at module level.
        import weaviate
        from weaviate.auth import AuthApiKey

        self._url = url
        self._collection_name = collection
        self._api_key = api_key

        parsed = urlparse(url if "://" in url else f"http://{url}")
        host = parsed.hostname or "localhost"
        is_cloud = host.endswith(".weaviate.network") or host.endswith(".weaviate.cloud")
        if is_cloud:
            if not api_key:
                raise ValueError("Weaviate Cloud requires api_key.")
            self._client = weaviate.connect_to_weaviate_cloud(
                cluster_url=url,
                auth_credentials=AuthApiKey(api_key),
            )
        else:
            port = parsed.port or (443 if parsed.scheme == "https" else 8080)
            auth = AuthApiKey(api_key) if api_key else None
            self._client = weaviate.connect_to_local(
                host=host,
                port=port,
                auth_credentials=auth,
            )
        # Created lazily on first upsert once we know the embedding dim.
        self._collection_ready = self._client.collections.exists(collection)

    # ------------------------------------------------------------------ writes

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        if not self._collection_ready:
            self._ensure_collection()
        from weaviate.classes.data import DataObject

        collection = self._client.collections.get(self._collection_name)
        objects = [
            DataObject(
                uuid=_uuid_for(it.id),
                vector=it.embedding,
                properties={
                    "chunk_id": it.id,
                    "text": it.text,
                    **_flatten_metadata(it.metadata),
                },
            )
            for it in items
        ]
        collection.data.insert_many(objects)

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        if not self._collection_ready:
            return
        collection = self._client.collections.get(self._collection_name)
        for cid in ids:
            collection.data.delete_by_id(_uuid_for(cid))

    # ------------------------------------------------------------------ reads

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        if not self._collection_ready:
            return []
        from weaviate.classes.query import MetadataQuery

        collection = self._client.collections.get(self._collection_name)
        result = collection.query.near_vector(
            near_vector=embedding,
            limit=max(1, k),
            return_metadata=MetadataQuery(distance=True),
        )
        return [_hit_from_object(o, score_from="distance") for o in result.objects]

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        """Weaviate's native BM25 + vector fusion. Headline feature of this adapter."""
        if not self._collection_ready:
            return []
        from weaviate.classes.query import MetadataQuery

        collection = self._client.collections.get(self._collection_name)
        result = collection.query.hybrid(
            query=text,
            vector=embedding,
            alpha=0.5,
            limit=max(1, k),
            return_metadata=MetadataQuery(score=True),
        )
        return [_hit_from_object(o, score_from="score") for o in result.objects]

    def count(self) -> int:
        if not self._collection_ready:
            return 0
        collection = self._client.collections.get(self._collection_name)
        agg = collection.aggregate.over_all(total_count=True)
        return int(agg.total_count or 0)

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            ready = bool(self._client.is_ready())
            latency_ms = (time.perf_counter() - t0) * 1000.0
            detail: dict[str, Any] = {
                "collection": self._collection_name,
                "url": self._url,
                "ready": ready,
                "collection_ready": self._collection_ready,
            }
            if self._collection_ready:
                detail["count"] = self.count()
            return ConnectionTest(ok=ready, latency_ms=latency_ms, detail=detail)
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))

    def close(self) -> None:
        """Release the underlying gRPC/HTTP client connections."""
        with contextlib.suppress(Exception):
            self._client.close()

    # ----------------------------------------------------------------- helpers

    def _ensure_collection(self) -> None:
        if self._client.collections.exists(self._collection_name):
            self._collection_ready = True
            return
        from weaviate.classes.config import (
            Configure,
            DataType,
            Property,
            VectorDistances,
        )

        logger.info("Creating Weaviate collection %r (cosine)", self._collection_name)
        self._client.collections.create(
            name=self._collection_name,
            vectorizer_config=Configure.Vectorizer.none(),
            vector_index_config=Configure.VectorIndex.hnsw(
                distance_metric=VectorDistances.COSINE,
            ),
            properties=[
                Property(name="chunk_id", data_type=DataType.TEXT),
                Property(name="text", data_type=DataType.TEXT),
                Property(name="path", data_type=DataType.TEXT),
                Property(name="start_line", data_type=DataType.INT),
                Property(name="end_line", data_type=DataType.INT),
            ],
        )
        self._collection_ready = True


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """Weaviate accepts richer payloads, but we mirror scalar discipline so
    swapping adapters never changes what metadata round-trips.
    """
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _hit_from_object(obj: Any, score_from: str) -> QueryHit:
    props = dict(obj.properties or {})
    chunk_id = props.pop("chunk_id", str(obj.uuid))
    text = props.pop("text", "")
    if score_from == "distance":
        # cosine distance in [0, 2]; similarity ~ 1 - distance.
        distance = getattr(obj.metadata, "distance", None) if obj.metadata else None
        score = 1.0 - float(distance) if distance is not None else 0.0
    else:
        raw = getattr(obj.metadata, "score", None) if obj.metadata else None
        score = float(raw) if raw is not None else 0.0
    return QueryHit(id=chunk_id, text=text, score=score, metadata=props)


def _uuid_for(chunk_id: str) -> str:
    """Stable UUIDv5 derived from the chunk id.

    Weaviate ids must be UUIDs; the original chunk_id is preserved on the
    object's ``chunk_id`` property so round-trips are lossless.
    """
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"bratan/{chunk_id}"))
