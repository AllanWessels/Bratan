"""Pinecone adapter — managed cloud vector store.

Pinecone requires an index to exist (with an explicit dimension) before any
upsert. We don't know the dimension at construction time, so the index is
created lazily on the first ``upsert`` if it doesn't already exist. Pinecone
also caps batched upserts at 100 vectors per call, so we chunk accordingly.

Native hybrid retrieval would need sparse vectors declared at index-create
time and a BM25 index populated alongside upserts — out of scope here.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)

# Pinecone caps a single upsert call at 100 vectors.
_UPSERT_BATCH = 100


class PineconeAdapter(VectorDBAdapter):
    """Pinecone-backed adapter.

    The index name is required up front; the caller is responsible for
    picking serverless vs pod-based when they create the index (or we
    auto-create with serverless defaults on first upsert if missing).
    Distance is fixed to cosine for parity with the rest of the pipeline.

    Pinecone vector ids are arbitrary strings — our 16-char hex chunk_id
    is used verbatim with no transformation.
    """

    def __init__(
        self,
        api_key: str,
        index_name: str,
        cloud: str = "aws",
        region: str = "us-east-1",
        namespace: str = "",
    ) -> None:
        if not api_key:
            raise ValueError("Pinecone api_key is required.")
        if not index_name:
            raise ValueError("Pinecone index_name is required.")
        # Local import keeps the optional dep truly optional at module level.
        from pinecone import Pinecone

        self._api_key = api_key
        self._index_name = index_name
        self._cloud = cloud
        self._region = region
        self._namespace = namespace
        self._client = Pinecone(api_key=api_key)
        self._index: Any | None = None
        # Cache whether the named index exists so we don't probe Pinecone on
        # every upsert. The probe runs on the first write that needs it.
        self._index_ready = False

    # ------------------------------------------------------------------ writes

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        index = self._ensure_index(vector_size=len(items[0].embedding))
        vectors = [
            {
                "id": it.id,
                "values": it.embedding,
                "metadata": {"text": it.text, **_flatten_metadata(it.metadata)},
            }
            for it in items
        ]
        for start in range(0, len(vectors), _UPSERT_BATCH):
            batch = vectors[start : start + _UPSERT_BATCH]
            if self._namespace:
                index.upsert(vectors=batch, namespace=self._namespace)
            else:
                index.upsert(vectors=batch)

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        index = self._get_index_if_exists()
        if index is None:
            return
        if self._namespace:
            index.delete(ids=ids, namespace=self._namespace)
        else:
            index.delete(ids=ids)

    # ------------------------------------------------------------------ reads

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        index = self._get_index_if_exists()
        if index is None:
            return []
        kwargs: dict[str, Any] = {
            "vector": embedding,
            "top_k": max(1, k),
            "include_metadata": True,
        }
        if self._namespace:
            kwargs["namespace"] = self._namespace
        result = index.query(**kwargs)
        return [_hit_from_match(m) for m in _matches(result)]

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        # Pinecone supports hybrid via sparse vectors, but the sparse index
        # must be declared at create-time. Defer to the caller-stitched path.
        return None

    def count(self) -> int:
        index = self._get_index_if_exists()
        if index is None:
            return 0
        stats = index.describe_index_stats()
        return int(_stats_total(stats))

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            indexes = [_index_name(ix) for ix in self._client.list_indexes()]
            exists = self._index_name in indexes
            detail: dict[str, Any] = {
                "index": self._index_name,
                "exists": exists,
                "indexes": indexes,
            }
            if exists:
                idx = self._get_or_open_index()
                stats = idx.describe_index_stats()
                detail["count"] = int(_stats_total(stats))
            latency_ms = (time.perf_counter() - t0) * 1000.0
            return ConnectionTest(ok=True, latency_ms=latency_ms, detail=detail)
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))

    # ----------------------------------------------------------------- helpers

    def _ensure_index(self, vector_size: int) -> Any:
        """Return the index, creating it on Pinecone if necessary."""
        if self._index is not None and self._index_ready:
            return self._index
        existing = [_index_name(ix) for ix in self._client.list_indexes()]
        if self._index_name not in existing:
            from pinecone import ServerlessSpec

            logger.info(
                "Creating Pinecone index %r (dim=%d, cosine, %s/%s)",
                self._index_name,
                vector_size,
                self._cloud,
                self._region,
            )
            self._client.create_index(
                name=self._index_name,
                dimension=vector_size,
                metric="cosine",
                spec=ServerlessSpec(cloud=self._cloud, region=self._region),
            )
        self._index = self._client.Index(self._index_name)
        self._index_ready = True
        return self._index

    def _get_index_if_exists(self) -> Any | None:
        """Return the index handle, or None if it has never been created."""
        if self._index is not None and self._index_ready:
            return self._index
        try:
            existing = [_index_name(ix) for ix in self._client.list_indexes()]
        except Exception as exc:
            logger.warning("Pinecone list_indexes failed: %s", exc)
            return None
        if self._index_name not in existing:
            return None
        self._index = self._client.Index(self._index_name)
        self._index_ready = True
        return self._index

    def _get_or_open_index(self) -> Any:
        if self._index is None:
            self._index = self._client.Index(self._index_name)
        return self._index


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """Pinecone metadata values must be str/int/float/bool or list[str]."""
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None:
            continue  # Pinecone rejects None
        if isinstance(v, (str, int, float, bool)) or (isinstance(v, list) and all(isinstance(x, str) for x in v)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _matches(result: Any) -> list[Any]:
    """Extract the matches list from a Pinecone query response.

    Pinecone returns either an object with a ``matches`` attribute or a dict
    with a ``matches`` key depending on client version; tolerate both.
    """
    if hasattr(result, "matches"):
        return list(result.matches or [])
    if isinstance(result, dict):
        return list(result.get("matches") or [])
    return []


def _hit_from_match(match: Any) -> QueryHit:
    if hasattr(match, "id"):
        mid = match.id
        score = float(getattr(match, "score", 0.0) or 0.0)
        metadata = dict(getattr(match, "metadata", None) or {})
    else:
        mid = match["id"]
        score = float(match.get("score", 0.0) or 0.0)
        metadata = dict(match.get("metadata") or {})
    text = metadata.pop("text", "")
    return QueryHit(id=str(mid), text=text, score=score, metadata=metadata)


def _stats_total(stats: Any) -> int:
    """Pull total_vector_count out of describe_index_stats, dict or object."""
    if hasattr(stats, "total_vector_count"):
        return int(stats.total_vector_count or 0)
    if isinstance(stats, dict):
        return int(stats.get("total_vector_count", 0) or 0)
    return 0


def _index_name(ix: Any) -> str:
    """Pull the name out of a Pinecone IndexModel / dict / plain string."""
    if isinstance(ix, str):
        return ix
    name = getattr(ix, "name", None)
    if name is not None:
        return str(name)
    if isinstance(ix, dict):
        return str(ix.get("name", ""))
    return str(ix)
