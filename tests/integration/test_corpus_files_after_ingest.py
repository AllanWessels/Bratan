"""Regression test for the ingest → list_corpus round-trip.

The class of test that would have caught the bug fixed in 7b48350:

    "I run ingest, it succeeds, files still say not ingested."

Root cause: `_ingested_path_counts` reached into `adapter._collection`
directly.  Under `BRATAN_CHROMA_SUBPROCESS_QUERY=1` (the long-running uvicorn
environment) the adapter is constructed in subprocess mode and intentionally
never calls `_connect()`, so `_collection` is None.  The `None.get(…)` raised
AttributeError, which was swallowed by the outer try/except, and every file
ended up with `ingested: false`.

Fix: route through `adapter.count_chunks_by_path()`, which respects the
subprocess flag and forks out to `scripts.query_worker` when it is set.

These tests reproduce the exact user workflow:
  1. Real corpus files on disk.
  2. Real ingest via `_ingest_sync` (stub embedder only — no GPU download).
  3. `list_corpus` called with `BRATAN_CHROMA_SUBPROCESS_QUERY=1` active.
  4. Assert every returned CorpusFile has ingested=True and n_chunks > 0.

Test 1 must FAIL on the pre-7b48350 code and PASS on the fix.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
import yaml

from ui.backend.schemas import BratanConfig, ProjectBasics, VectorDBConfig

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_config(project_root: Path, cfg: BratanConfig) -> Path:
    """Serialise *cfg* to ``project_root/bratan.config.yaml`` and return the path."""
    config_path = project_root / "bratan.config.yaml"
    config_path.write_text(
        yaml.safe_dump(cfg.model_dump(mode="json"), sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return config_path


def _make_cfg(project_root: Path) -> BratanConfig:
    """Build a BratanConfig that points all paths at the hermetic tmp dir."""
    return BratanConfig(
        vector_db=VectorDBConfig(
            chroma_path=str(project_root / ".chroma"),
            chroma_collection="corpus_files_regression",
        ),
        project=ProjectBasics(
            corpus_path=str(project_root / "corpus"),
        ),
    )


def _drop_corpus(project_root: Path) -> None:
    """Write two small, distinct .md files into the corpus directory."""
    (project_root / "corpus" / "otter.md").write_text(
        "# Sea Otter\n\n"
        "Sea otters are marine mammals found along the Pacific coast.\n"
        "They float on their backs and crack shellfish on their chests.\n"
        "Otters hold hands while sleeping so they don't drift apart.\n",
        encoding="utf-8",
    )
    (project_root / "corpus" / "capybara.md").write_text(
        "# Capybara\n\n"
        "The capybara is the world's largest rodent, native to South America.\n"
        "Capybaras are semi-aquatic and highly social animals.\n"
        "They are known for living peacefully alongside many other species.\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Test 1 — the primary regression guard
# ---------------------------------------------------------------------------


def test_corpus_files_reports_ingested_true_after_real_ingest(
    tmp_project: Path,
    stub_embedder,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Full ingest → list_corpus round-trip with BRATAN_CHROMA_SUBPROCESS_QUERY=1.

    This is the test that would have caught the 7b48350 bug.

    The env flag simulates the long-running uvicorn environment where the
    ChromaAdapter is constructed in subprocess mode (``_collection = None``).
    Pre-fix code calls ``adapter._collection.get(…)`` which raises
    AttributeError on None, gets swallowed, and returns {} — so every file
    reports ingested=False.  Post-fix code routes through
    ``adapter.count_chunks_by_path()`` which forks ``scripts.query_worker``
    and reads the on-disk SQLite fresh — so every file correctly reports
    ingested=True.
    """
    _drop_corpus(tmp_project)
    cfg = _make_cfg(tmp_project)
    _write_config(tmp_project, cfg)

    # Ingest: the worker must NOT be subject to subprocess_query — it is the
    # write path.  We deliberately do NOT set BRATAN_CHROMA_SUBPROCESS_QUERY
    # yet, so _ingest_sync opens a direct PersistentClient and upserts chunks.
    from pipeline import ingest

    n_chunks = ingest._ingest_sync(cfg)
    assert n_chunks >= 2, (
        f"expected at least 1 chunk per file (2 files); got {n_chunks}. "
        "Check that stub_embedder is wired and the corpus files were created."
    )

    # NOW flip the subprocess_query flag — this is what uvicorn has set at
    # startup.  list_corpus -> _ingested_path_counts -> get_vectordb -> opens
    # ChromaAdapter in subprocess mode.  The bug manifested here.
    monkeypatch.setenv("BRATAN_CHROMA_SUBPROCESS_QUERY", "1")

    # Flush the module-level chroma client caches so the adapter constructed
    # inside _ingested_path_counts gets the flag from the environment rather
    # than an already-constructed in-process client.
    from pipeline.adapters.chroma import drop_in_process_clients

    drop_in_process_clients()

    corpus_files = ingest.list_corpus(Path(cfg.project.corpus_path))

    # Exactly two files: otter.md and capybara.md (README.md is excluded).
    assert len(corpus_files) == 2, (
        f"expected 2 CorpusFile entries, got {len(corpus_files)}: "
        f"{[f.path for f in corpus_files]}"
    )

    for cf in corpus_files:
        assert cf.ingested, (
            f"{cf.path}: ingested=False after a successful ingest. "
            "This is the 7b48350 regression: _ingested_path_counts is reading "
            "a None _collection instead of routing through count_chunks_by_path()."
        )
        assert cf.n_chunks is not None and cf.n_chunks > 0, (
            f"{cf.path}: n_chunks={cf.n_chunks!r} — expected a positive integer."
        )


# ---------------------------------------------------------------------------
# Test 2 — same guarantee, exercised through start_ingest_task subprocess path
# ---------------------------------------------------------------------------


def test_corpus_files_reports_ingested_true_after_subprocess_ingest(
    tmp_project: Path,
    stub_embedder,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Variant of Test 1 that runs ingest via start_ingest_task (the real API path).

    start_ingest_task spawns scripts.ingest_worker as a subprocess — exactly
    what POST /api/corpus/ingest does.  We then poll get_ingest_status until
    succeeded, set BRATAN_CHROMA_SUBPROCESS_QUERY=1, and call list_corpus.

    The same assertion must hold: every file ingested=True, n_chunks > 0.
    """
    _drop_corpus(tmp_project)
    cfg = _make_cfg(tmp_project)
    _write_config(tmp_project, cfg)

    from pipeline import ingest

    # Kick off the subprocess worker.
    status = ingest.start_ingest_task(cfg)
    assert status.state in {"running", "succeeded"}, (
        f"start_ingest_task returned unexpected state {status.state!r}: {status.error}"
    )

    # Poll until terminal (succeeded or failed).  The worker is fast (stub
    # embedder, two small files) but subprocess startup adds latency.
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        status = ingest.get_ingest_status()
        if status.state in {"succeeded", "failed"}:
            break
        time.sleep(0.25)

    assert status.state == "succeeded", (
        f"Ingest worker finished with state={status.state!r}, "
        f"chunks_written={status.chunks_written}, error={status.error!r}. "
        "Check that the ingest subprocess can import pipeline + scripts correctly."
    )
    assert status.chunks_written >= 2, (
        f"expected ≥2 chunks, got {status.chunks_written}"
    )

    # Now simulate the uvicorn read environment.
    monkeypatch.setenv("BRATAN_CHROMA_SUBPROCESS_QUERY", "1")

    from pipeline.adapters.chroma import drop_in_process_clients

    drop_in_process_clients()

    corpus_files = ingest.list_corpus(Path(cfg.project.corpus_path))

    assert len(corpus_files) == 2, (
        f"expected 2 CorpusFile entries, got {len(corpus_files)}: "
        f"{[f.path for f in corpus_files]}"
    )

    for cf in corpus_files:
        assert cf.ingested, (
            f"{cf.path}: ingested=False after subprocess ingest succeeded. "
            "Regression: _ingested_path_counts must route through "
            "count_chunks_by_path() when BRATAN_CHROMA_SUBPROCESS_QUERY is set."
        )
        assert cf.n_chunks is not None and cf.n_chunks > 0, (
            f"{cf.path}: n_chunks={cf.n_chunks!r} — expected a positive integer."
        )
