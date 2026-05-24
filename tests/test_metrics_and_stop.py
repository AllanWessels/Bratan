"""Unit tests for metrics.build_report and stop_criteria.evaluate."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from pipeline.judge import JudgeVerdict
from pipeline.metrics import (
    IterationReport,
    build_report,
    pipeline_manifest_hash,
)
from pipeline.stop_criteria import LoopState, evaluate
from ui.backend.schemas import (
    BratanConfig,
    FailureCategory,
    PassageRef,
    SeedCase,
    StopCriteria,
)


def _case(case_id: str, category: FailureCategory) -> SeedCase:
    return SeedCase(
        id=case_id,
        question="q",
        ground_truth="gt",
        source_passages=[PassageRef(path="a.md", line_start=1, line_end=2)],
        failure_category=category,
        created_at=datetime.now(UTC),
        created_by="human",
    )


def _verdict(
    case_id: str,
    composite: float,
    *,
    mode: str = "oracle",
    correctness: float | None = 1.0,
    faithfulness: float | None = 1.0,
    recall: float = 1.0,
    tokens_in: int = 100,
    tokens_out: int = 20,
) -> JudgeVerdict:
    return JudgeVerdict(
        case_id=case_id,
        composite=composite,
        retrieval_recall_at_5=recall,
        answer_correctness=correctness,
        faithfulness=faithfulness,
        judge_mode=mode,  # type: ignore[arg-type]
        model_used="test-model",
        judge_weights_hash="deadbeef0000",
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=42.0,
    )


# ---------------------------------------------------------------------------
# build_report
# ---------------------------------------------------------------------------


def test_build_report_basic_aggregation() -> None:
    cfg = BratanConfig()
    cases = [
        _case("a", FailureCategory.PARAPHRASE_BRITTLENESS),
        _case("b", FailureCategory.PARAPHRASE_BRITTLENESS),
        _case("c", FailureCategory.MULTI_HOP),
    ]
    verdicts = [
        _verdict("a", 1.0),
        _verdict("b", 0.4),
        _verdict("c", 0.9),
    ]
    report = build_report(iteration=1, cfg=cfg, cases=cases, verdicts=verdicts)

    assert report.iteration == 1
    assert report.test_set_size == 3
    assert report.composite_mean == pytest.approx((1.0 + 0.4 + 0.9) / 3)
    assert report.pass_rate_at_0_6 == pytest.approx(2 / 3)
    assert "paraphrase_brittleness" in report.per_category
    assert report.per_category["paraphrase_brittleness"].count == 2
    assert report.per_category["paraphrase_brittleness"].avg_composite == pytest.approx(0.7)
    assert report.cost.oracle_calls == 3
    assert report.cost.prejudge_calls == 0
    assert report.cost.tokens_in == 300
    assert report.cost.tokens_out == 60


def test_build_report_regressions_and_recoveries() -> None:
    cfg = BratanConfig()
    cases = [_case("a", FailureCategory.STRAIGHTFORWARD), _case("b", FailureCategory.STRAIGHTFORWARD)]
    previous = build_report(
        iteration=1,
        cfg=cfg,
        cases=cases,
        verdicts=[_verdict("a", 0.9), _verdict("b", 0.4)],
    )
    current = build_report(
        iteration=2,
        cfg=cfg,
        cases=cases,
        verdicts=[_verdict("a", 0.3), _verdict("b", 0.8)],
        previous=previous,
    )
    assert len(current.regressions) == 1
    assert current.regressions[0].case_id == "a"
    assert current.recoveries == ["b"]


def test_pipeline_manifest_hash_returns_stable_string() -> None:
    h = pipeline_manifest_hash()
    assert isinstance(h, str) and len(h) == 16
    assert h == pipeline_manifest_hash()  # idempotent within process


# ---------------------------------------------------------------------------
# stop_criteria
# ---------------------------------------------------------------------------


def _state(**overrides) -> LoopState:
    defaults = dict(
        iteration=1,
        history=[],
        usd_spent=0.0,
        recent_drift_rates=[],
        recent_blue_outcomes=[],
        manual_stop_requested=False,
    )
    defaults.update(overrides)
    return LoopState(**defaults)


def _report(composite_mean: float, **overrides) -> IterationReport:
    return IterationReport(
        timestamp="2026-01-01T00:00:00Z",
        iteration=overrides.get("iteration", 1),
        pipeline_manifest_hash="x" * 16,
        test_set_size=overrides.get("test_set_size", 1),
        composite_mean=composite_mean,
        composite_stdev=0.0,
        pass_rate_at_0_6=overrides.get("pass_rate", 0.5),
        regressions=overrides.get("regressions", []),
        judge_weights_hash="d" * 12,
    )


def test_stop_manual_wins() -> None:
    cfg = BratanConfig()
    s = _state(manual_stop_requested=True, usd_spent=999.0)
    assert evaluate(cfg, _report(0.5), s) == "manual"


def test_stop_budget() -> None:
    cfg = BratanConfig()
    cfg.cost.usd_per_run = 1.0
    assert evaluate(cfg, _report(0.5), _state(usd_spent=2.0)) == "budget"


def test_stop_max_iterations() -> None:
    cfg = BratanConfig(stop=StopCriteria(max_iterations=5))
    assert evaluate(cfg, _report(0.5), _state(iteration=5)) == "max_iterations"


def test_stop_anchor_regression() -> None:
    cfg = BratanConfig()
    cfg.stop.anchor_regression_threshold = 0.3
    from pipeline.metrics import Regression

    rep = _report(0.5, regressions=[Regression(case_id="a", previous=0.9, current=0.4)])
    assert evaluate(cfg, rep, _state()) == "anchor_regression"


def test_stop_judge_drift() -> None:
    cfg = BratanConfig()
    s = _state(recent_drift_rates=[0.07, 0.08, 0.06])
    assert evaluate(cfg, _report(0.5), s) == "judge_drift"


def test_stop_blue_stall() -> None:
    cfg = BratanConfig()
    s = _state(recent_blue_outcomes=["accept", "revert", "revert", "revert"])
    assert evaluate(cfg, _report(0.5), s) == "blue_stall"


def test_stop_convergence() -> None:
    cfg = BratanConfig(stop=StopCriteria(convergence_threshold=0.02, convergence_window=3))
    history = [_report(0.80), _report(0.805)]
    current = _report(0.81)
    assert evaluate(cfg, current, _state(history=history)) == "convergence"


def test_no_stop_when_under_window() -> None:
    cfg = BratanConfig(stop=StopCriteria(convergence_window=5))
    history = [_report(0.5), _report(0.51)]
    current = _report(0.512)
    assert evaluate(cfg, current, _state(history=history)) is None
