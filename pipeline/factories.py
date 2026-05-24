"""Factories for constructing adapters from a `BratanConfig`."""

from __future__ import annotations

import importlib
import logging
from pathlib import Path

from pipeline.adapters.base import VectorDBAdapter
from ui.backend.schemas import BratanConfig
from ui.backend.schemas import VectorDBAdapter as AdapterEnum

logger = logging.getLogger(__name__)


def get_vectordb(cfg: BratanConfig) -> VectorDBAdapter:
    """Build the configured adapter."""
    adapter = cfg.vector_db.adapter
    if adapter == AdapterEnum.CHROMA:
        from pipeline.adapters.chroma import ChromaAdapter

        return ChromaAdapter(
            path=Path(cfg.vector_db.chroma_path),
            collection=cfg.vector_db.chroma_collection,
        )
    if adapter == AdapterEnum.QDRANT:
        from pipeline.adapters.qdrant import QdrantAdapter

        if not cfg.vector_db.qdrant_url:
            raise ValueError(
                "vector_db.adapter is 'qdrant' but vector_db.qdrant_url is empty; "
                "set it to a reachable Qdrant URL (e.g. http://localhost:6333)."
            )
        return QdrantAdapter(
            url=cfg.vector_db.qdrant_url,
            api_key=cfg.vector_db.qdrant_api_key,
            collection=cfg.vector_db.chroma_collection,
        )
    if adapter == AdapterEnum.PINECONE:
        from pipeline.adapters.pinecone import PineconeAdapter

        if not cfg.vector_db.pinecone_api_key:
            raise ValueError(
                "vector_db.adapter is 'pinecone' but vector_db.pinecone_api_key "
                "is empty; provide a Pinecone API key."
            )
        if not cfg.vector_db.pinecone_index:
            raise ValueError(
                "vector_db.adapter is 'pinecone' but vector_db.pinecone_index "
                "is empty; provide the name of the Pinecone index to use."
            )
        return PineconeAdapter(
            api_key=cfg.vector_db.pinecone_api_key,
            index_name=cfg.vector_db.pinecone_index,
            cloud=cfg.vector_db.pinecone_cloud,
            region=cfg.vector_db.pinecone_region,
            namespace=cfg.vector_db.pinecone_namespace,
        )
    if adapter == AdapterEnum.WEAVIATE:
        from pipeline.adapters.weaviate import WeaviateAdapter

        if not cfg.vector_db.weaviate_url:
            raise ValueError(
                "vector_db.adapter is 'weaviate' but vector_db.weaviate_url "
                "is empty; provide a reachable Weaviate URL "
                "(e.g. http://localhost:8080 or https://<cluster>.weaviate.network)."
            )
        return WeaviateAdapter(
            url=cfg.vector_db.weaviate_url,
            api_key=cfg.vector_db.weaviate_api_key,
            collection=cfg.vector_db.weaviate_collection,
        )
    if adapter == AdapterEnum.PGVECTOR:
        from pipeline.adapters.pgvector import PgvectorAdapter

        if not cfg.vector_db.pgvector_dsn:
            raise ValueError(
                "vector_db.adapter is 'pgvector' but vector_db.pgvector_dsn "
                "is empty; provide a Postgres DSN "
                "(e.g. postgresql://user:pw@localhost:5432/bratan)."
            )
        return PgvectorAdapter(
            dsn=cfg.vector_db.pgvector_dsn,
            table=cfg.vector_db.pgvector_table,
        )
    if adapter == AdapterEnum.OTHER:
        module_path = cfg.vector_db.other_adapter_module
        class_name = cfg.vector_db.other_adapter_class
        if not module_path:
            raise ValueError(
                "vector_db.adapter is 'other' but vector_db.other_adapter_module "
                "is empty; provide the Python module path holding your "
                "VectorDBAdapter subclass (e.g. 'myproject.my_adapter')."
            )
        if not class_name:
            raise ValueError(
                "vector_db.adapter is 'other' but vector_db.other_adapter_class "
                "is empty; provide the class name to instantiate."
            )
        return _load_custom_adapter(cfg, module_path, class_name)
    raise ValueError(f"Unknown vector_db.adapter: {adapter!r}")


def _load_custom_adapter(
    cfg: BratanConfig, module_path: str, class_name: str
) -> VectorDBAdapter:
    """Import and instantiate a user-provided VectorDBAdapter subclass.

    The class is instantiated with no positional arguments and the
    ``vector_db`` section of the config as keyword arguments, so users can
    cherry-pick whichever fields they need.
    """
    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        raise ValueError(
            f"Could not import custom adapter module {module_path!r}: {exc}"
        ) from exc
    cls = getattr(module, class_name, None)
    if cls is None:
        raise ValueError(
            f"Module {module_path!r} has no attribute {class_name!r}."
        )
    if not isinstance(cls, type) or not issubclass(cls, VectorDBAdapter):
        raise ValueError(
            f"{module_path}.{class_name} is not a VectorDBAdapter subclass."
        )
    try:
        return cls(**cfg.vector_db.model_dump())  # type: ignore[call-arg]
    except TypeError:
        # Custom adapters that don't accept the full kwarg blast can use a
        # zero-arg constructor and read settings themselves.
        logger.info(
            "Custom adapter %s.%s didn't accept VectorDBConfig kwargs; "
            "instantiating with no args.",
            module_path,
            class_name,
        )
        return cls()
