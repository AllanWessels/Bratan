"""Qdrant adapter — ships in M5.

Qdrant has native sparse-vector support and could provide a real hybrid
retrieval path, but turning that on requires declaring sparse vectors at
collection-create time and indexing BM25 weights up front — a substantial
schema change. M5 ships the dense path only; hybrid retrieval is stitched
together by the caller exactly as it is for ChromaDB.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from qdrant_client import QdrantClient, models

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)


class QdrantAdapter(VectorDBAdapter):
    """Qdrant-backed adapter.

    The collection is created lazily on the first ``upsert`` so the vector
    size can be inferred from the embeddings actually being written; no
    embedding model needs to be known at construction time. Distance is
    fixed to cosine, matching the rest of the pipeline.

    Qdrant point ids must be ints or UUIDs, but the pipeline uses 16-char
    hex content hashes. The original id is preserved in the payload as
    ``chunk_id``; a stable 60-bit numeric id derived from the hash is used
    as the on-the-wire point id.
    """

    def __init__(self, url: str, api_key: str | None, collection: str = "corpus") -> None:
        self._url = url
        self._collection_name = collection
        # ":memory:" is treated as a sentinel for the in-process client (used
        # by tests). Anything else is parsed as a URL by qdrant-client.
        if url == ":memory:":
            self._client = QdrantClient(location=":memory:")
        else:
            self._client = QdrantClient(url=url, api_key=api_key)
        # Created lazily on first upsert once we know the embedding dim.
        self._collection_ready = self._client.collection_exists(collection)

    # ------------------------------------------------------------------ writes

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        if not self._collection_ready:
            self._ensure_collection(vector_size=len(items[0].embedding))
        points = [
            models.PointStruct(
                id=_point_id(it.id),
                vector=it.embedding,
                payload={"chunk_id": it.id, "text": it.text, **_flatten_metadata(it.metadata)},
            )
            for it in items
        ]
        self._client.upsert(collection_name=self._collection_name, points=points, wait=True)

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        if not self._collection_ready:
            return
        self._client.delete(
            collection_name=self._collection_name,
            points_selector=models.PointIdsList(points=[_point_id(i) for i in ids]),
            wait=True,
        )

    # ------------------------------------------------------------------ reads

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        if not self._collection_ready:
            return []
        result = self._client.query_points(
            collection_name=self._collection_name,
            query=embedding,
            limit=max(1, k),
            with_payload=True,
        )
        return [_hit_from_point(p) for p in result.points]

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        # TODO(M5+): native sparse vectors. Qdrant supports sparse vectors but
        # they have to be declared at collection-create time and require a BM25
        # index to be populated alongside upserts — out of scope for M5.
        return None

    def count(self) -> int:
        if not self._collection_ready:
            return 0
        return int(self._client.count(collection_name=self._collection_name).count)

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            cols = self._client.get_collections()
            latency_ms = (time.perf_counter() - t0) * 1000.0
            return ConnectionTest(
                ok=True,
                latency_ms=latency_ms,
                detail={
                    "collection": self._collection_name,
                    "url": self._url,
                    "collections": [c.name for c in cols.collections],
                    "collection_ready": self._collection_ready,
                },
            )
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))

    # ----------------------------------------------------------------- helpers

    def _ensure_collection(self, vector_size: int) -> None:
        if self._client.collection_exists(self._collection_name):
            self._collection_ready = True
            return
        self._client.create_collection(
            collection_name=self._collection_name,
            vectors_config=models.VectorParams(
                size=vector_size, distance=models.Distance.COSINE
            ),
        )
        self._collection_ready = True


def _point_id(chunk_id: str) -> int:
    """Stable 60-bit numeric id derived from our 16-hex-char content hash.

    Qdrant requires ints or UUIDs as point ids; the original string id is
    preserved in payload.``chunk_id`` so round-trips are lossless. Using 15
    hex chars keeps the value comfortably under Qdrant's unsigned-64-bit
    ceiling regardless of how the client serialises it.
    """
    head = chunk_id[:15] or "0"
    try:
        return int(head, 16)
    except ValueError:
        # Non-hex ids: fall back to a stable hash. Collisions are
        # vanishingly unlikely for our short ids but theoretically possible;
        # callers should keep id schemes consistent.
        return abs(hash(chunk_id)) & ((1 << 60) - 1)


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """Qdrant accepts richer payloads than Chroma, but we mirror its scalar
    discipline so swapping adapters never changes what metadata round-trips.
    """
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _hit_from_point(point: Any) -> QueryHit:
    payload = point.payload or {}
    chunk_id = payload.get("chunk_id") or str(point.id)
    text = payload.get("text", "")
    metadata = {k: v for k, v in payload.items() if k not in ("chunk_id", "text")}
    return QueryHit(
        id=chunk_id,
        text=text,
        score=float(point.score),
        metadata=metadata,
    )
