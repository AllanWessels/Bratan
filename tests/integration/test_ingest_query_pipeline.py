"""Integration: corpus -> ingest -> chromadb -> query.

Stubs only the GPU embedder and Anthropic SDK call. Everything else (chunker,
content-hash IDs, chromadb storage + retrieval, prompt rendering) is real.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ui.backend.schemas import BratanConfig, VectorDBConfig


@pytest.fixture
def populated_corpus(tmp_project: Path) -> Path:
    (tmp_project / "corpus" / "fox.md").write_text(
        "# Fox\n\nThe quick brown fox jumps over the lazy dog.\n"
        "Foxes are clever omnivores native to forests.\n"
    )
    (tmp_project / "corpus" / "pelican.md").write_text(
        "# Pelican\n\nPelicans are large water birds with throat pouches.\n"
        "They dive from great heights to catch fish.\n"
    )
    return tmp_project


def _cfg(project_root: Path) -> BratanConfig:
    return BratanConfig(
        vector_db=VectorDBConfig(
            chroma_path=str(project_root / ".chroma"),
            chroma_collection="integration",
        ),
    )


def test_ingest_indexes_all_files(
    populated_corpus: Path, stub_embedder, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(populated_corpus)
    cfg.project.corpus_path = str(populated_corpus / "corpus")

    from pipeline import ingest

    n_chunks = ingest._ingest_sync(cfg)
    assert n_chunks >= 2, "expected at least one chunk per file"

    # Confirm the adapter actually persisted them.
    from pipeline.factories import get_vectordb

    adapter = get_vectordb(cfg)
    assert adapter.count() == n_chunks


def test_query_ranks_relevant_doc_first(
    populated_corpus: Path, stub_embedder, fake_anthropic
) -> None:
    cfg = _cfg(populated_corpus)
    cfg.project.corpus_path = str(populated_corpus / "corpus")

    from pipeline import ingest, query

    ingest._ingest_sync(cfg)
    out = query.search_corpus(cfg, "the quick brown fox jumps over the lazy dog", k=5)

    assert len(out.passages) > 0
    # Top hit must come from fox.md (deterministic hash embedder + exact query).
    top = out.passages[0]
    assert top.path == "fox.md"
    assert top.line_start >= 1
    assert top.line_end >= top.line_start


def test_answer_returns_grounded_response_with_retrieved_chunks(
    populated_corpus: Path, stub_embedder, fake_anthropic
) -> None:
    cfg = _cfg(populated_corpus)
    cfg.project.corpus_path = str(populated_corpus / "corpus")

    from pipeline import ingest, query

    ingest._ingest_sync(cfg)
    out = query.answer(cfg, "What does the fox do?", k=3)

    # Stubbed Anthropic returns a fixed answer string.
    assert out["answer"] == "Stub grounded answer based on retrieved passages."
    assert "retrieved" in out
    assert len(out["retrieved"]) > 0
    assert out["model"] == cfg.models.oracle_model
    assert out.get("warning") is None  # api_key was set by the fixture


def test_naive_pipeline_score_substring_match(stub_embedder, fake_anthropic) -> None:
    from pipeline.query import naive_pipeline_score

    assert naive_pipeline_score("the lazy dog", "The fox jumps over the lazy dog.") == 1.0
    assert naive_pipeline_score("the lazy dog", "Foxes are clever.") == 0.0
    assert naive_pipeline_score("", "anything") == 0.0
