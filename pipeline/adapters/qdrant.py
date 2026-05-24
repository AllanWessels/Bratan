"""Qdrant adapter — native hybrid (dense + sparse BM25-shape) retrieval.

Qdrant supports named vectors per point, so a single collection can carry
both a dense (cosine) lane and a sparse lane indexed BM25-style. We exploit
that to provide a true ``hybrid_query_if_supported`` via Qdrant's native
``Prefetch`` + ``FusionQuery(Fusion.RRF)``.

Design choices worth knowing:

* **Sparse vectorizer is hashing-based, not corpus-fitted.** Building a real
  fitted BM25 (with IDF tables) at ingest time is a chicken-and-egg problem:
  Qdrant wants sparse vectors *per point at upsert*, and our adapters
  upsert in batches as embeddings stream in — there is no global "fit"
  pass. A hashed sparse vectorizer (token -> stable bucket index, TF as
  weight with log dampening) sidesteps the cold-start cleanly and is the
  same shape Qdrant itself uses for unfitted BM25-style sparse retrieval.
  Query and upsert paths are symmetric by construction.

* **No SPLADE.** SPLADE-class neural sparse retrievers would need a heavy
  transformer load on every chunk. ``rank-bm25`` is already a dep and is
  fast enough; SPLADE belongs behind an opt-in flag, not in the default.

* **Schema bumped.** Collections written under the old (dense-only,
  unnamed-vector) schema can't be queried with the new sparse-aware code
  path. We surface that as a clear ``ValueError`` instructing the user to
  drop + re-ingest rather than silently degrading to dense-only.
"""

from __future__ import annotations

import logging
import math
import re
import time
from typing import Any

from qdrant_client import QdrantClient, models
from qdrant_client.http.exceptions import UnexpectedResponse

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)

# Named-vector lane labels. These are part of the on-disk schema; renaming
# them silently corrupts existing collections.
_DENSE_VECTOR_NAME = "dense"
_SPARSE_VECTOR_NAME = "sparse"

# 2^20 = 1,048,576 buckets. Wide enough that collisions on the sub-million
# unique tokens any reasonable corpus has are statistically rare, narrow
# enough that the index footprint stays small.
_SPARSE_BUCKETS = 1 << 20

# Match anything that looks like a word, including unicode letters and digits.
# Kept simple on purpose — fancier tokenizers belong in a skill, not the adapter.
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


class QdrantAdapter(VectorDBAdapter):
    """Qdrant-backed adapter with native hybrid retrieval.

    The collection is created lazily on the first ``upsert`` so the dense
    vector size can be inferred from the embeddings actually being written.
    Both the dense lane (cosine) and the sparse lane (BM25-shape) are
    declared up front; every point carries both vectors.

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
            self._ensure_collection_exists(vector_size=len(items[0].embedding))
        points = [
            models.PointStruct(
                id=_point_id(it.id),
                vector={
                    _DENSE_VECTOR_NAME: it.embedding,
                    _SPARSE_VECTOR_NAME: _to_sparse_vector(_sparse_vectorize(it.text)),
                },
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
        try:
            result = self._client.query_points(
                collection_name=self._collection_name,
                query=embedding,
                using=_DENSE_VECTOR_NAME,
                limit=max(1, k),
                with_payload=True,
            )
        except (ValueError, UnexpectedResponse) as exc:
            _raise_if_legacy_schema(exc)
            raise
        return [_hit_from_point(p) for p in result.points]

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        """Fuse dense + sparse retrieval natively via Qdrant's RRF.

        Returns ``None`` only when the collection hasn't been created yet
        (i.e. nothing has been ingested). Callers can fall back to a
        manually stitched hybrid if they want, but the typical case here is
        "no data, no results".
        """
        if not self._collection_ready:
            return None
        sparse_vec = _to_sparse_vector(_sparse_vectorize(text))
        try:
            result = self._client.query_points(
                collection_name=self._collection_name,
                prefetch=[
                    models.Prefetch(
                        query=embedding,
                        using=_DENSE_VECTOR_NAME,
                        limit=max(1, k),
                    ),
                    models.Prefetch(
                        query=sparse_vec,
                        using=_SPARSE_VECTOR_NAME,
                        limit=max(1, k),
                    ),
                ],
                query=models.FusionQuery(fusion=models.Fusion.RRF),
                limit=max(1, k),
                with_payload=True,
            )
        except (ValueError, UnexpectedResponse) as exc:
            _raise_if_legacy_schema(exc)
            raise
        return [_hit_from_point(p) for p in result.points]

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

    def _ensure_collection_exists(self, vector_size: int) -> None:
        """Create the collection with both dense and sparse named-vector lanes.

        Idempotent: if the collection already exists we assume it was created
        by a previous run of this same code path. Old (dense-only) collections
        won't match the schema and queries against them will fall through to
        ``_raise_if_legacy_schema`` for a clear error.
        """
        if self._client.collection_exists(self._collection_name):
            self._collection_ready = True
            return
        self._client.create_collection(
            collection_name=self._collection_name,
            vectors_config={
                _DENSE_VECTOR_NAME: models.VectorParams(
                    size=vector_size,
                    distance=models.Distance.COSINE,
                ),
            },
            sparse_vectors_config={
                _SPARSE_VECTOR_NAME: models.SparseVectorParams(),
            },
        )
        self._collection_ready = True


# ============================================================ sparse vectorizer


def _sparse_vectorize(text: str) -> dict[int, float]:
    """Produce a BM25-shape ``{bucket_index: weight}`` map from raw text.

    Stateless and corpus-independent on purpose — see the module docstring for
    why we don't fit a global IDF table. The weighting is term frequency with
    log dampening (``1 + log(tf)``), which is what BM25 does inside its TF
    saturation factor before length normalization. Without a corpus we can't
    do the length normalization or IDF half, but the relative ranking of
    repeated vs. one-shot terms within a query is preserved, and that's the
    bit a sparse-vector ANN actually exploits.

    Empty / whitespace-only input returns ``{}``, which Qdrant accepts as a
    zero-token query (the sparse lane contributes nothing to fusion, the
    dense lane carries the result).
    """
    if not text:
        return {}
    tokens = _tokenize(text)
    if not tokens:
        return {}
    tf: dict[int, int] = {}
    for tok in tokens:
        idx = _bucket_index(tok)
        tf[idx] = tf.get(idx, 0) + 1
    return {idx: 1.0 + math.log(count) for idx, count in tf.items()}


def _tokenize(text: str) -> list[str]:
    """Lowercase, alphanumeric-word tokenization.

    No stemming, no stop-word removal. Stop words push down the IDF naturally
    in BM25; we don't have IDF here, but stop-word frequency is roughly
    equal across docs, so they contribute roughly equal noise to every
    score and wash out in the ranking. The juice isn't worth the dependency.
    """
    return [m.group(0).lower() for m in _TOKEN_RE.finditer(text)]


def _bucket_index(token: str) -> int:
    """Hash a token to a stable bucket id in ``[0, _SPARSE_BUCKETS)``.

    Uses Python's ``hash()`` masked into a 20-bit space. Process-stable
    because ``PYTHONHASHSEED`` is set by uv/pytest, but if it weren't, a
    pipeline restart could shift the bucket assignment of every term —
    which would silently invalidate any persistent Qdrant instance. The
    fix is to use a deterministic hash; ``hashlib.blake2b`` is fast enough
    that this isn't worth optimizing.
    """
    import hashlib

    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=4).digest()
    return int.from_bytes(digest, "big") % _SPARSE_BUCKETS


def _to_sparse_vector(weights: dict[int, float]) -> models.SparseVector:
    """Materialize a ``{idx: weight}`` dict into Qdrant's wire format."""
    if not weights:
        return models.SparseVector(indices=[], values=[])
    # Sort for determinism; Qdrant doesn't require it but it makes test
    # output easier to reason about.
    items = sorted(weights.items())
    return models.SparseVector(
        indices=[i for i, _ in items],
        values=[w for _, w in items],
    )


# ================================================================ id + helpers


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


# ============================================================ schema migration


# Markers from Qdrant client / server when the on-disk collection schema
# pre-dates the named-vector + sparse-vector layout this adapter requires.
# These need a hard re-ingest; we surface a clear error rather than papering
# over it.
_LEGACY_SCHEMA_MARKERS = (
    "Sparse vector sparse is not found",
    "sparse is not found in the collection",
    "Vector name error",
    "Vector params for",
    "is not configured",
    "Wrong input: Vector",
    "Wrong vector dimension",
)


def _raise_if_legacy_schema(exc: Exception) -> None:
    """If ``exc`` matches a legacy-schema marker, re-raise as a clearer error.

    Existing collections written before this adapter learned about sparse
    vectors don't have a ``sparse`` lane, and queries against them will
    blow up deep inside qdrant-client. We catch that specific shape and
    tell the user exactly what to do: drop and re-ingest. Anything else
    is allowed to propagate untouched.
    """
    msg = str(exc)
    if any(marker in msg for marker in _LEGACY_SCHEMA_MARKERS):
        raise ValueError(
            "Qdrant collection has no sparse-vector lane, which this adapter "
            "requires for native hybrid retrieval. This happens when the "
            "collection was created under an older (dense-only) schema. "
            "Drop the collection and re-ingest the corpus to upgrade it. "
            f"(underlying error: {exc})"
        ) from exc
