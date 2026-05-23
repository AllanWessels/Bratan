"""Evaluate the loop's stop conditions and return a `stop_reason` enum.

ANY firing criterion stops the loop. The final report records which one fired.

Inputs the evaluator needs (passed in by the orchestrator):
- the freshly built IterationReport for this iteration
- the rolling history of prior reports (for convergence window math)
- the current iteration index and the configured max
- the running usd_spent vs the budget
- a snapshot of recent blue-team commit outcomes (for blue_stall)
- a snapshot of recent drift rates (for judge_drift)
- a manual-stop flag (Ctrl-C / API stop button)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pipeline.metrics import IterationReport, StopReason
from ui.backend.schemas import BratanConfig

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LoopState:
    iteration: int
    history: list[IterationReport]
    usd_spent: float
    recent_drift_rates: list[float]
    recent_blue_outcomes: list[str]  # "accept" | "revert" | "noop"
    manual_stop_requested: bool = False


def evaluate(cfg: BratanConfig, current: IterationReport, state: LoopState) -> StopReason | None:
    """Return the first stop reason that fires, or None to continue."""
    if state.manual_stop_requested:
        return "manual"
    if _budget_exceeded(cfg, state.usd_spent):
        return "budget"
    if state.iteration >= cfg.stop.max_iterations:
        return "max_iterations"
    if _anchor_regression(cfg, current):
        return "anchor_regression"
    if _judge_drift(state.recent_drift_rates):
        return "judge_drift"
    if _blue_stall(state.recent_blue_outcomes):
        return "blue_stall"
    if _converged(cfg, current, state.history):
        return "convergence"
    return None


def _budget_exceeded(cfg: BratanConfig, usd_spent: float) -> bool:
    limit = cfg.cost.usd_per_run
    return limit > 0 and usd_spent >= limit


def _anchor_regression(cfg: BratanConfig, current: IterationReport) -> bool:
    threshold = cfg.stop.anchor_regression_threshold
    return any(
        (r.previous - r.current) >= threshold for r in current.regressions
    )


def _judge_drift(recent_rates: list[float]) -> bool:
    """Fires when prejudge↔oracle disagreement > 5% on 3 consecutive checks."""
    if len(recent_rates) < 3:
        return False
    return all(rate > 0.05 for rate in recent_rates[-3:])


def _blue_stall(outcomes: list[str]) -> bool:
    """Fires when the last 3 blue-team iterations ended in revert."""
    if len(outcomes) < 3:
        return False
    return outcomes[-3:] == ["revert", "revert", "revert"]


def _converged(
    cfg: BratanConfig, current: IterationReport, history: list[IterationReport]
) -> bool:
    """Composite delta within threshold over the rolling window."""
    window = cfg.stop.convergence_window
    threshold = cfg.stop.convergence_threshold
    if window <= 1:
        return False
    series = [r.composite_mean for r in history[-(window - 1):]] + [current.composite_mean]
    if len(series) < window:
        return False
    deltas = [abs(series[i] - series[i - 1]) for i in range(1, len(series))]
    return all(d < threshold for d in deltas)
