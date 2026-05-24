"""Unit tests for pipeline.judge.drift_check.

Stubs out:
- /reports/history/ via the metrics module's REPORTS_DIR.
- seed_store._read_all_cases to return a small fixture set.
- pipeline.query.answer + judge._call_anthropic so no network calls happen.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from pipeline import judge as judge_mod
from pipeline import metrics as metrics_mod
from ui.backend.schemas import (
    BratanConfig,
    FailureCategory,
    ModelConfig,
    Passage,
    PassageRef,
    SeedCase,
)


def _case(case_id: str = "c-1") -> SeedCase:
    return SeedCase(
        id=case_id,
        question=f"q for {case_id}",
        ground_truth="gt",
        source_passages=[PassageRef(path="a.md", line_start=1, line_end=2)],
        failure_category=FailureCategory.STRAIGHTFORWARD,
        created_at=datetime.now(UTC),
        created_by="human",
    )


def _write_history(history_dir: Path, *, case_id: str, composite: float, mode: str = "oracle") -> None:
    history_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "timestamp": "2026-01-01T00:00:00+00:00",
        "iteration": 0,
        "pipeline_manifest_hash": "deadbeef",
        "test_set_size": 1,
        "composite_mean": composite,
        "composite_stdev": 0.0,
        "pass_rate_at_0_6": 1.0,
        "per_category": {},
        "regressions": [],
        "recoveries": [],
        "by_case": [
            {
                "case_id": case_id,
                "composite": composite,
                "retrieval_recall_at_5": 1.0,
                "answer_correctness": 1.0,
                "faithfulness": 1.0,
                "failure_category": "straightforward",
                "judge_mode": mode,
                "latency_ms": 1.0,
            }
        ],
        "cost": {
            "oracle_calls": 1, "prejudge_calls": 0, "cache_hits": 0,
            "usd_spent": 0.0, "tokens_in": 0, "tokens_out": 0,
        },
        "latency": {
            "p50_total_ms": 0.0, "p95_total_ms": 0.0,
            "p50_retrieval_ms": 0.0, "p95_retrieval_ms": 0.0,
            "p50_generation_ms": 0.0, "p95_generation_ms": 0.0,
        },
        "drift": {"samples_checked": 0, "disagreement_rate": 0.0},
        "judge_weights_hash": "abc",
        "low_confidence_verdicts": [],
        "stop_reason": None,
    }
    (history_dir / f"run-{case_id}.json").write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def tmp_reports(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(metrics_mod, "PROJECT_ROOT", tmp_path, raising=True)
    monkeypatch.setattr(metrics_mod, "REPORTS_DIR", tmp_path / "reports", raising=True)
    (tmp_path / "reports" / "history").mkdir(parents=True, exist_ok=True)
    return tmp_path / "reports" / "history"


def test_drift_returns_zero_when_n_samples_zero(tmp_reports: Path) -> None:
    block = judge_mod.drift_check(BratanConfig(), n_samples=0)
    assert block.samples_checked == 0
    assert block.disagreement_rate == 0.0


def test_drift_returns_zero_when_history_empty(tmp_reports: Path) -> None:
    # tmp_reports is empty by default.
    block = judge_mod.drift_check(BratanConfig(), n_samples=5)
    assert block.samples_checked == 0
    assert block.disagreement_rate == 0.0


def test_drift_ignores_prejudge_rows(tmp_reports: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_history(tmp_reports, case_id="p-1", composite=0.9, mode="prejudge")

    from ui.backend import seed_store
    monkeypatch.setattr(seed_store, "_read_all_cases", lambda: [_case("p-1")])

    block = judge_mod.drift_check(BratanConfig(), n_samples=5)
    assert block.samples_checked == 0


def test_drift_agreement(tmp_reports: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """New verdict matches prior — 0% disagreement."""
    _write_history(tmp_reports, case_id="c-1", composite=1.0)

    from ui.backend import seed_store
    monkeypatch.setattr(seed_store, "_read_all_cases", lambda: [_case("c-1")])

    # Stub out pipeline.query.answer + judge._call_anthropic so the re-grade
    # yields a verdict equivalent to the historical one.
    from pipeline import query as query_mod
    monkeypatch.setattr(
        query_mod, "answer",
        lambda cfg, q, k=5: {
            "answer": "the answer",
            "retrieved": [Passage(path="a.md", line_start=1, line_end=2, content="x")],
            "latency_ms": 0.0,
            "model": "stub",
        },
    )

    def fake_call(api_key, model, prompt):
        return ('{"score": 1.0, "reason": "ok", "low_confidence": false}', 10, 5)

    monkeypatch.setattr(judge_mod, "_call_anthropic", fake_call)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "stub")

    block = judge_mod.drift_check(BratanConfig(), n_samples=5)
    assert block.samples_checked == 1
    assert block.disagreement_rate == 0.0


def test_drift_disagreement_when_composite_differs(
    tmp_reports: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prior composite=1.0 but re-grade now scores 0.0 — disagreement = 100%."""
    _write_history(tmp_reports, case_id="c-1", composite=1.0)

    from ui.backend import seed_store
    monkeypatch.setattr(seed_store, "_read_all_cases", lambda: [_case("c-1")])

    from pipeline import query as query_mod
    monkeypatch.setattr(
        query_mod, "answer",
        lambda cfg, q, k=5: {
            "answer": "wrong answer",
            "retrieved": [Passage(path="other.md", line_start=99, line_end=100, content="x")],
            "latency_ms": 0.0,
            "model": "stub",
        },
    )

    def fake_call(api_key, model, prompt):
        return ('{"score": 0.0, "reason": "wrong", "low_confidence": false}', 10, 5)

    monkeypatch.setattr(judge_mod, "_call_anthropic", fake_call)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "stub")

    block = judge_mod.drift_check(BratanConfig(), n_samples=5)
    assert block.samples_checked == 1
    assert block.disagreement_rate == 1.0


def test_drift_skips_cases_no_longer_in_seed(
    tmp_reports: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_history(tmp_reports, case_id="ghost", composite=1.0)

    from ui.backend import seed_store
    monkeypatch.setattr(seed_store, "_read_all_cases", lambda: [])  # case no longer present

    block = judge_mod.drift_check(BratanConfig(), n_samples=5)
    assert block.samples_checked == 0
