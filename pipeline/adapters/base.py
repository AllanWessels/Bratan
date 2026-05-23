"""Abstract base class for vector-DB adapters and shared data models.

The adapter is the *only* swap point in the pipeline. Blue team owns everything
above this line; users own which adapter is plugged in.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, Field

from ui.backend.schemas import ConnectionTest


class ChunkRecord(BaseModel):
    """A single chunk ready to be upserted into a vector store."""

    id: str
    text: str
    embedding: list[float]
    metadata: dict[str, Any] = Field(default_factory=dict)


class QueryHit(BaseModel):
    """A single result from a vector or hybrid query."""

    id: str
    text: str
    score: float
    metadata: dict[str, Any] = Field(default_factory=dict)


class VectorDBAdapter(ABC):
    """The narrow contract every vector backend implements.

    Blue team writes against this abstract surface; users plug in the backend
    of their choice by implementing the methods below.
    """

    @abstractmethod
    def upsert(self, items: list[ChunkRecord]) -> None:
        """Insert or replace items. Idempotent on `id`."""

    @abstractmethod
    def vector_query(self, embedding: list[float], k: int) -> list[QueryHit]:
        """Pure ANN search against the stored embeddings."""

    @abstractmethod
    def hybrid_query_if_supported(
        self, text: str, embedding: list[float], k: int
    ) -> list[QueryHit] | None:
        """Native hybrid (BM25 + vector) search if the backend offers it.

        Returns None when the backend has no native BM25; in that case the
        caller is responsible for stitching together its own hybrid retrieval.
        """

    @abstractmethod
    def delete(self, ids: list[str]) -> None:
        """Delete items by id. No-op for ids not present."""

    @abstractmethod
    def count(self) -> int:
        """Total number of items stored."""

    @abstractmethod
    def health_check(self) -> ConnectionTest:
        """Cheap reachability + sanity probe used by the setup wizard."""
