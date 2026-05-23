"""Factories for constructing adapters from a `BratanConfig`."""

from __future__ import annotations

import logging
from pathlib import Path

from pipeline.adapters.base import VectorDBAdapter
from ui.backend.schemas import BratanConfig
from ui.backend.schemas import VectorDBAdapter as AdapterEnum

logger = logging.getLogger(__name__)


def get_vectordb(cfg: BratanConfig) -> VectorDBAdapter:
    """Build the configured adapter. M1 only ships Chroma."""
    adapter = cfg.vector_db.adapter
    if adapter == AdapterEnum.CHROMA:
        from pipeline.adapters.chroma import ChromaAdapter

        return ChromaAdapter(
            path=Path(cfg.vector_db.chroma_path),
            collection=cfg.vector_db.chroma_collection,
        )
    if adapter == AdapterEnum.QDRANT:
        from pipeline.adapters.qdrant import QdrantAdapter

        return QdrantAdapter()
    if adapter == AdapterEnum.PINECONE:
        from pipeline.adapters.pinecone import PineconeAdapter

        return PineconeAdapter()
    if adapter == AdapterEnum.WEAVIATE:
        from pipeline.adapters.weaviate import WeaviateAdapter

        return WeaviateAdapter()
    if adapter == AdapterEnum.PGVECTOR:
        from pipeline.adapters.pgvector import PgvectorAdapter

        return PgvectorAdapter()
    raise ValueError(f"Unknown vector_db.adapter: {adapter!r}")
