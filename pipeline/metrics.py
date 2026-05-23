"""Per-iteration report builder.

Aggregates JudgeVerdicts + cost counters + latency stats into the report schema
documented in docs/metrics.md (and in the approved plan). One report per iteration
goes to /reports/run-<ts>.json; /reports/latest.json copies the latest.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean, stdev
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from pipeline.judge import JudgeVerdict
from ui.backend.schemas import BratanConfig, FailureCategory, SeedCase

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REPORTS_DIR = PROJECT_ROOT / "reports"

StopReason = Literal[
    "convergence",
    "budget",
    "max_iterations",
    "anchor_regression",
    "judge_drift",
    "blue_stall",
    "manual",
]

PASS_THRESHOLD = 0.6


# ---------------------------------------------------------------------------
# Report shapes
# ---------------------------------------------------------------------------


class CostBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    oracle_calls: int = 0
    prejudge_calls: int = 0
    cache_hits: int = 0
    usd_spent: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0


class LatencyBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p50_total_ms: float = 0.0
    p95_total_ms: float = 0.0
    p50_retrieval_ms: float = 0.0
    p95_retrieval_ms: float = 0.0
    p50_generation_ms: float = 0.0
    p95_generation_ms: float = 0.0


class DriftBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples_checked: int = 0
    disagreement_rate: float = 0.0


class CategoryStats(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int
    avg_composite: float
    pass_rate: float


class CaseScore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_id: str
    composite: float
    retrieval_recall_at_5: float
    answer_correctness: float | None
    faithfulness: float | None
    failure_category: FailureCategory
    judge_mode: str
    latency_ms: float


class Regression(BaseModel):
    model_config = ConfigDict(extra="forbid")
    case_id: str
    previous: float
    current: float


class IterationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamp: str
    iteration: int
    pipeline_manifest_hash: str
    test_set_size: int
    composite_mean: float
    composite_stdev: float
    pass_rate_at_0_6: float
    per_category: dict[str, CategoryStats] = Field(default_factory=dict)
    regressions: list[Regression] = Field(default_factory=list)
    recoveries: list[str] = Field(default_factory=list)
    by_case: list[CaseScore] = Field(default_factory=list)
    cost: CostBlock = Field(default_factory=CostBlock)
    latency: LatencyBlock = Field(default_factory=LatencyBlock)
    drift: DriftBlock = Field(default_factory=DriftBlock)
    judge_weights_hash: str
    low_confidence_verdicts: list[dict] = Field(default_factory=list)
    stop_reason: StopReason | None = None


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build_report(
    *,
    iteration: int,
    cfg: BratanConfig,
    cases: list[SeedCase],
    verdicts: list[JudgeVerdict],
    retrieval_latencies_ms: list[float] | None = None,
    generation_latencies_ms: list[float] | None = None,
    usd_spent: float = 0.0,
    cache_hits: int = 0,
    drift: DriftBlock | None = None,
    stop_reason: StopReason | None = None,
    previous: IterationReport | None = None,
) -> IterationReport:
    """Assemble all metrics for one iteration."""
    case_by_id = {c.id: c for c in cases}
    composites = [v.composite for v in verdicts]
    mean_c = mean(composites) if composites else 0.0
    std_c = stdev(composites) if len(composites) > 1 else 0.0
    pass_rate = (
        sum(1 for v in verdicts if v.composite >= PASS_THRESHOLD) / len(verdicts)
        if verdicts
        else 0.0
    )

    by_case_rows: list[CaseScore] = []
    by_category: dict[str, list[float]] = defaultdict(list)
    low_conf: list[dict] = []
    oracle_calls = prejudge_calls = 0
    tokens_in = tokens_out = 0

    for v in verdicts:
        case = case_by_id.get(v.case_id)
        if case is None:
            logger.warning("verdict for unknown case_id %s", v.case_id)
            continue
        by_case_rows.append(
            CaseScore(
                case_id=v.case_id,
                composite=v.composite,
                retrieval_recall_at_5=v.retrieval_recall_at_5,
                answer_correctness=v.answer_correctness,
                faithfulness=v.faithfulness,
                failure_category=case.failure_category,
                judge_mode=v.judge_mode,
                latency_ms=v.latency_ms,
            )
        )
        by_category[case.failure_category.value].append(v.composite)
        if v.judge_mode == "oracle":
            oracle_calls += 1
        else:
            prejudge_calls += 1
        tokens_in += v.tokens_in
        tokens_out += v.tokens_out
        for reason in v.low_confidence_reasons:
            low_conf.append({"case_id": v.case_id, "reason": reason})

    per_category = {
        category: CategoryStats(
            count=len(scores),
            avg_composite=mean(scores),
            pass_rate=sum(1 for s in scores if s >= PASS_THRESHOLD) / len(scores),
        )
        for category, scores in by_category.items()
    }

    regressions, recoveries = _diff_against_previous(verdicts, previous)

    return IterationReport(
        timestamp=datetime.now(UTC).isoformat(),
        iteration=iteration,
        pipeline_manifest_hash=pipeline_manifest_hash(),
        test_set_size=len(cases),
        composite_mean=mean_c,
        composite_stdev=std_c,
        pass_rate_at_0_6=pass_rate,
        per_category=per_category,
        regressions=regressions,
        recoveries=recoveries,
        by_case=by_case_rows,
        cost=CostBlock(
            oracle_calls=oracle_calls,
            prejudge_calls=prejudge_calls,
            cache_hits=cache_hits,
            usd_spent=usd_spent,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        ),
        latency=_latency_block(
            verdicts, retrieval_latencies_ms or [], generation_latencies_ms or []
        ),
        drift=drift or DriftBlock(),
        judge_weights_hash=(verdicts[0].judge_weights_hash if verdicts else _empty_weights_hash(cfg)),
        low_confidence_verdicts=low_conf,
        stop_reason=stop_reason,
    )


def _diff_against_previous(
    verdicts: list[JudgeVerdict], previous: IterationReport | None
) -> tuple[list[Regression], list[str]]:
    if previous is None:
        return [], []
    prev_by_id = {c.case_id: c.composite for c in previous.by_case}
    regressions: list[Regression] = []
    recoveries: list[str] = []
    for v in verdicts:
        prior = prev_by_id.get(v.case_id)
        if prior is None:
            continue
        if prior >= PASS_THRESHOLD > v.composite:
            regressions.append(
                Regression(case_id=v.case_id, previous=prior, current=v.composite)
            )
        elif prior < PASS_THRESHOLD <= v.composite:
            recoveries.append(v.case_id)
    return regressions, recoveries


def _latency_block(
    verdicts: list[JudgeVerdict],
    retrieval_ms: list[float],
    generation_ms: list[float],
) -> LatencyBlock:
    judge_totals = [v.latency_ms for v in verdicts]
    return LatencyBlock(
        p50_total_ms=_percentile(judge_totals, 50),
        p95_total_ms=_percentile(judge_totals, 95),
        p50_retrieval_ms=_percentile(retrieval_ms, 50),
        p95_retrieval_ms=_percentile(retrieval_ms, 95),
        p50_generation_ms=_percentile(generation_ms, 50),
        p95_generation_ms=_percentile(generation_ms, 95),
    )


def _percentile(values: list[float], p: int) -> float:
    if not values:
        return 0.0
    sv = sorted(values)
    k = (len(sv) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(sv) - 1)
    if lo == hi:
        return sv[lo]
    return sv[lo] + (sv[hi] - sv[lo]) * (k - lo)


def _empty_weights_hash(cfg: BratanConfig) -> str:
    from pipeline.judge import _hash_weights

    return _hash_weights(cfg.judge_weights)


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def write_report(report: IterationReport) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    history_dir = REPORTS_DIR / "history"
    history_dir.mkdir(exist_ok=True)
    stamp = report.timestamp.replace(":", "-").replace(".", "-")
    target = REPORTS_DIR / f"run-{stamp}.json"
    target.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    (REPORTS_DIR / "latest.json").write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )
    (history_dir / target.name).write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )
    return target


def load_latest() -> IterationReport | None:
    path = REPORTS_DIR / "latest.json"
    if not path.exists():
        return None
    try:
        return IterationReport.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not parse latest.json: %s", exc)
        return None


def append_regressions_md(report: IterationReport) -> None:
    if not report.regressions:
        return
    path = REPORTS_DIR / "regressions.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"\n## Iteration {report.iteration} — {report.timestamp}\n"]
    for r in report.regressions:
        lines.append(
            f"- `{r.case_id}`: {r.previous:.2f} -> {r.current:.2f} "
            f"(Δ {r.current - r.previous:+.2f})"
        )
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Pipeline manifest hash
# ---------------------------------------------------------------------------


def pipeline_manifest_hash() -> str:
    """SHA1 over the pipeline/ tree + pipeline/config.yaml — ties a report to exact code.

    Uses `git ls-files` when in a git tree (fast + respects .gitignore); falls back to
    a directory walk hashing file contents.
    """
    try:
        out = subprocess.check_output(
            ["git", "ls-tree", "-r", "HEAD", "--", "pipeline/"],
            cwd=PROJECT_ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        return hashlib.sha1(out.encode("utf-8")).hexdigest()[:16]
    except Exception:
        h = hashlib.sha1()
        for path in sorted((PROJECT_ROOT / "pipeline").rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            h.update(path.relative_to(PROJECT_ROOT).as_posix().encode("utf-8"))
            h.update(b"\x00")
            h.update(path.read_bytes())
            h.update(b"\x00")
        return h.hexdigest()[:16]


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)
