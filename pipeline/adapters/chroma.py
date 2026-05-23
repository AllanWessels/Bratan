"""ChromaDB adapter — the default vector store shipped with M1."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

logger = logging.getLogger(__name__)


class ChromaAdapter(VectorDBAdapter):
    """Persistent ChromaDB-backed adapter.

    We always pass in our own embeddings; ChromaDB's default embedding function
    is disabled so the pipeline owns the embedding model end-to-end.
    """

    def __init__(self, path: str | Path, collection: str = "corpus") -> None:
        self._path = Path(path)
        self._path.mkdir(parents=True, exist_ok=True)
        self._collection_name = collection
        self._client = chromadb.PersistentClient(
            path=str(self._path),
            settings=Settings(anonymized_telemetry=False, allow_reset=True),
        )
        self._collection = self._client.get_or_create_collection(
            name=collection,
            embedding_function=None,
            metadata={"hnsw:space": "cosine"},
        )

    def upsert(self, items: list[ChunkRecord]) -> None:
        if not items:
            return
        ids = [it.id for it in items]
        embeddings = [it.embedding for it in items]
        documents = [it.text for it in items]
        metadatas = [_flatten_metadata(it.metadata) for it in items]
        self._collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas,
        )

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        result = self._collection.query(
            query_embeddings=[embedding],
            n_results=max(1, k),
            include=["documents", "metadatas", "distances"],
        )
        return _hits_from_chroma_result(result)

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        # ChromaDB has no native BM25 — caller stitches hybrid retrieval itself.
        return None

    def delete(self, ids: list[str]) -> None:
        if not ids:
            return
        self._collection.delete(ids=ids)

    def count(self) -> int:
        return int(self._collection.count())

    def health_check(self) -> ConnectionTest:
        t0 = time.perf_counter()
        try:
            n = self._collection.count()
            latency_ms = (time.perf_counter() - t0) * 1000.0
            return ConnectionTest(
                ok=True,
                latency_ms=latency_ms,
                detail={
                    "collection": self._collection_name,
                    "path": str(self._path),
                    "count": n,
                },
            )
        except Exception as exc:
            return ConnectionTest(ok=False, error=str(exc))


def _flatten_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """ChromaDB only accepts scalar metadata values."""
    out: dict[str, Any] = {}
    for k, v in meta.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out


def _hits_from_chroma_result(result: dict[str, Any]) -> list[QueryHit]:
    ids = (result.get("ids") or [[]])[0]
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    hits: list[QueryHit] = []
    for i, _id in enumerate(ids):
        # cosine distance -> similarity score
        distance = float(dists[i]) if i < len(dists) and dists[i] is not None else 0.0
        score = 1.0 - distance
        hits.append(
            QueryHit(
                id=_id,
                text=docs[i] if i < len(docs) else "",
                score=score,
                metadata=metas[i] if i < len(metas) and metas[i] else {},
            )
        )
    return hits
