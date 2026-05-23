"""Smoke tests for the M1 wire contract.

These do not exercise the pipeline end-to-end — they verify that the schemas + FastAPI
app + pipeline modules import cleanly and that the route surface matches the plan.
Once the M1 backend agent finishes, these should all pass without changes.
"""

from __future__ import annotations

import importlib

import pytest


def test_schemas_import() -> None:
    schemas = importlib.import_module("ui.backend.schemas")
    for name in [
        "BratanConfig",
        "SetupState",
        "ProbeResult",
        "ConnectionTest",
        "CorpusSearchRequest",
        "CorpusSearchResponse",
        "SeedValidateRequest",
        "SeedValidateResponse",
        "SeedSaveRequest",
        "SeedSaveResponse",
        "SeedListResponse",
        "FailureCategory",
        "VectorDBAdapter",
    ]:
        assert hasattr(schemas, name), f"schemas.{name} is missing"


def test_app_routes_present() -> None:
    pytest.importorskip("ui.backend.app", reason="backend agent has not finished yet")
    from ui.backend.app import app

    paths = {route.path for route in app.routes if hasattr(route, "path")}
    for required in [
        "/api/health",
        "/api/setup/state",
        "/api/setup/probe",
        "/api/setup/test-vectordb",
        "/api/setup/test-anthropic",
        "/api/setup/test-vllm",
        "/api/setup/save-step",
        "/api/setup/finish",
        "/api/config",
        "/api/corpus/files",
        "/api/corpus/search",
        "/api/corpus/passage",
        "/api/corpus/ingest",
        "/api/corpus/ingest/status",
        "/api/seed/validate",
        "/api/seed/save",
        "/api/seed/list",
    ]:
        assert required in paths, f"missing route: {required}"


def test_pipeline_modules_import() -> None:
    pytest.importorskip("pipeline.adapters.base", reason="backend agent has not finished yet")
    from pipeline import embeddings, factories, ingest, query
    from pipeline.adapters import base, chroma

    assert hasattr(base, "VectorDBAdapter")
    assert hasattr(chroma, "ChromaAdapter")
    assert hasattr(embeddings, "get_embedder")
    assert hasattr(factories, "get_vectordb")
    assert hasattr(ingest, "list_corpus")
    assert hasattr(query, "search_corpus")
    assert hasattr(query, "answer")
    assert hasattr(query, "naive_pipeline_score")


def test_failure_categories_match_schema_doc() -> None:
    from ui.backend.schemas import FailureCategory

    expected = {
        "paraphrase_brittleness",
        "multi_hop",
        "structured_content",
        "temporal_reasoning",
        "negation_or_scope",
        "disambiguation",
        "out_of_scope",
        "straightforward",
    }
    assert {c.value for c in FailureCategory} == expected
