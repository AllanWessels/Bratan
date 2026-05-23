"""Qdrant adapter stub — ships in M5."""

from __future__ import annotations

from pipeline.adapters.base import ChunkRecord, QueryHit, VectorDBAdapter
from ui.backend.schemas import ConnectionTest

_MSG = "This adapter ships in M5 — please use chroma for now."


class QdrantAdapter(VectorDBAdapter):
    def __init__(self, *args: object, **kwargs: object) -> None:
        raise NotImplementedError(_MSG)

    def upsert(self, items: list[ChunkRecord]) -> None:
        raise NotImplementedError(_MSG)

    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        raise NotImplementedError(_MSG)

    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        raise NotImplementedError(_MSG)

    def delete(self, ids: list[str]) -> None:
        raise NotImplementedError(_MSG)

    def count(self) -> int:
        raise NotImplementedError(_MSG)

    def health_check(self) -> ConnectionTest:
        raise NotImplementedError(_MSG)
