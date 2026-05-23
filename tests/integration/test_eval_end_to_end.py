"""Integration: scripts/eval.py main() end-to-end.

Drives the full eval path: corpus -> ingest -> seed.jsonl -> pipeline.answer ->
judge -> metrics.build_report -> /reports/run-*.json on disk. Only stubs the
GPU embedder and Anthropic SDK.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from ui.backend.schemas import BratanConfig, FailureCategory, PassageRef, SeedCase

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def seeded_project(
    tmp_project: Path,
    stub_embedder,
    fake_anthropic,
    monkeypatch: pytest.MonkeyPatch,
):
    # corpus
    (tmp_project / "corpus" / "fox.md").write_text(
        "# Fox\nThe quick brown fox jumps over the lazy dog.\nFoxes are clever.\n"
    )
    (tmp_project / "corpus" / "pelican.md").write_text(
        "# Pelican\nPelicans dive from great heights to catch fish.\n"
    )

    # seed.jsonl with two cases in schema.md format
    seed_lines = [
        SeedCase(
            id="fox-001",
            question="What does the fox jump over?",
            ground_truth="the lazy dog",
            source_passages=[PassageRef(path="fox.md", line_start=2, line_end=2)],
            failure_category=FailureCategory.STRAIGHTFORWARD,
            created_at=datetime.now(UTC),
            created_by="human",
        ),
        SeedCase(
            id="pelican-001",
            question="How do pelicans catch fish?",
            ground_truth="They dive from great heights",
            source_passages=[PassageRef(path="pelican.md", line_start=2, line_end=2)],
            failure_category=FailureCategory.STRAIGHTFORWARD,
            created_at=datetime.now(UTC),
            created_by="human",
        ),
    ]
    seed_path = tmp_project / "test_cases" / "seed.jsonl"
    seed_path.write_text(
        "\n".join(json.dumps(c.model_dump(mode="json")) for c in seed_lines) + "\n"
    )

    # bratan.config.yaml — points at the tmp corpus + tmp chroma
    cfg = BratanConfig()
    cfg.project.corpus_path = str(tmp_project / "corpus")
    cfg.vector_db.chroma_path = str(tmp_project / ".chroma")
    cfg.vector_db.chroma_collection = "integration_eval"
    (tmp_project / "bratan.config.yaml").write_text(
        __import__("yaml").safe_dump(cfg.model_dump(mode="json"), sort_keys=False)
    )

    # Pre-ingest so eval doesn't need to. eval doesn't trigger ingest itself.
    from pipeline import ingest

    ingest._ingest_sync(cfg)

    return tmp_project


def _load_eval_module():
    """Import scripts/eval.py under a stable module name."""
    if "scripts_eval" in sys.modules:
        importlib.reload(sys.modules["scripts_eval"])
        return sys.modules["scripts_eval"]
    spec = importlib.util.spec_from_file_location("scripts_eval", ROOT / "scripts" / "eval.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["scripts_eval"] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_eval_main_writes_report_with_schema(
    seeded_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    eval_mod = _load_eval_module()

    # eval.py uses a module-level DEFAULT_CONFIG pointing at the real repo;
    # redirect it to the tmp project.
    monkeypatch.setattr(eval_mod, "DEFAULT_CONFIG", seeded_project / "bratan.config.yaml")
    monkeypatch.setattr(eval_mod, "_ROOT", seeded_project)

    # Drive main() via argv.
    monkeypatch.setattr(sys, "argv", ["eval.py", "--iteration", "1"])
    rc = eval_mod.main()
    assert rc == 0

    reports = sorted((seeded_project / "reports").glob("run-*.json"))
    assert reports, "expected at least one run report on disk"
    latest = json.loads((seeded_project / "reports" / "latest.json").read_text())

    # Schema contract — these keys are documented in pipeline.metrics.IterationReport.
    for key in (
        "timestamp",
        "iteration",
        "pipeline_manifest_hash",
        "test_set_size",
        "composite_mean",
        "pass_rate_at_0_6",
        "per_category",
        "regressions",
        "recoveries",
        "by_case",
        "cost",
        "latency",
        "drift",
        "judge_weights_hash",
    ):
        assert key in latest, f"missing report key: {key}"

    # Two seed cases -> two by_case rows.
    assert latest["test_set_size"] == 2
    assert len(latest["by_case"]) == 2
    case_ids = {row["case_id"] for row in latest["by_case"]}
    assert case_ids == {"fox-001", "pelican-001"}

    # Stub judge returned 1.0/1.0 for both rubrics; recall@5 is real (case
    # has source_passages, retrieval is real). Composite must be in [0, 1].
    for row in latest["by_case"]:
        assert 0.0 <= row["composite"] <= 1.0
        assert row["answer_correctness"] == 1.0
        assert row["faithfulness"] == 1.0
        assert row["judge_mode"] == "oracle"

    # Per-category breakdown should contain "straightforward" with count=2.
    assert "straightforward" in latest["per_category"]
    assert latest["per_category"]["straightforward"]["count"] == 2

    # Cost block should have oracle_calls == 2 (one per case, real-budget bookkeeping
    # is per-case, two rubrics each but oracle_calls counts cases not rubric calls).
    assert latest["cost"]["oracle_calls"] == 2
    assert latest["cost"]["tokens_in"] > 0
