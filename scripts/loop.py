"""Orchestrator for the red-team / blue-team / judge loop.

Sequence per iteration (defaults; `--skip-red` and `--iterations 0` adjust):
    1. red-team   → appends new test cases to /test_cases/generated/<ts>.jsonl
    2. blue-team  → edits /pipeline/, atomically commits one focused change
    3. eval (oracle)  → runs every case, writes /reports/run-<ts>.json
    4. stop_criteria.evaluate() decides whether to continue

`--iterations 0` runs only the baseline eval (no agents) — useful to lock in
the starting score before any blue-team edit.

Usage:
    uv run python scripts/loop.py --iterations 1
    uv run python scripts/loop.py --iterations 0          # baseline only
    uv run python scripts/loop.py --iterations 20 --budget-usd 5
    uv run python scripts/loop.py --iterations 1 --skip-red
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from pipeline import agent_runner, metrics, stop_criteria  # noqa: E402
from pipeline.stop_criteria import LoopState  # noqa: E402
from ui.backend.config_store import load as load_config  # noqa: E402

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = _ROOT / "bratan.config.yaml"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--iterations", type=int, default=1)
    p.add_argument(
        "--skip-red",
        action="store_true",
        help="Skip the red team this run (blue + judge only).",
    )
    p.add_argument(
        "--budget-usd",
        type=float,
        default=None,
        help="Abort early if total spend exceeds this dollar amount.",
    )
    p.add_argument(
        "--no-agents",
        action="store_true",
        help="Skip red+blue subprocess invocations; only run the eval. Useful when "
        "the `claude` CLI is not available or for baseline scoring.",
    )
    args = p.parse_args()

    cfg = load_config(DEFAULT_CONFIG)

    history: list[metrics.IterationReport] = []
    if (latest := metrics.load_latest()) is not None:
        history.append(latest)
    blue_outcomes: list[str] = []
    drift_rates: list[float] = []
    usd_spent = 0.0

    # Iteration 0 (baseline): just eval, no agents, no commits.
    if args.iterations == 0:
        report = _run_eval(args, iteration=0)
        if report is None:
            return 2
        _print_summary(0, report, None)
        return 0

    for i in range(1, args.iterations + 1):
        logger.info("=== iteration %d / %d ===", i, args.iterations)

        if not args.no_agents and not args.skip_red:
            _run_agent_safe("red-team")
        if not args.no_agents:
            _run_agent_safe("blue-team")
            outcome = _commit_pipeline_changes(i)
            blue_outcomes.append(outcome)

        report = _run_eval(args, iteration=i)
        if report is None:
            logger.error("eval produced no report; aborting loop")
            return 2

        usd_spent += report.cost.usd_spent
        state = LoopState(
            iteration=i,
            history=history,
            usd_spent=usd_spent,
            recent_drift_rates=drift_rates,
            recent_blue_outcomes=blue_outcomes,
            manual_stop_requested=False,
        )
        reason = stop_criteria.evaluate(cfg, report, state)
        if reason:
            logger.info("STOP: %s", reason)
            report.stop_reason = reason
            metrics.write_report(report)
            _print_summary(i, report, reason)
            return 0

        history.append(report)
        _print_summary(i, report, None)

    return 0


def _run_agent_safe(name) -> None:
    try:
        run = agent_runner.run_agent(name)
        logger.info(
            "  agent %s exit=%d duration=%.1fs (log: %s)%s",
            name,
            run.exit_code,
            run.duration_s,
            run.log_path.relative_to(_ROOT),
            "  [config mutation reverted]" if run.config_was_mutated else "",
        )
    except Exception as exc:
        logger.warning("agent %s failed to launch: %s — continuing", name, exc)


def _run_eval(args, iteration: int):
    cmd = [
        sys.executable,
        str(_ROOT / "scripts" / "eval.py"),
        "--iteration",
        str(iteration),
        "--mode",
        "oracle",
    ]
    if args.budget_usd is not None:
        cmd.extend(["--budget-usd", str(args.budget_usd)])
    logger.info("  running: %s", " ".join(cmd[-6:]))
    t0 = time.perf_counter()
    rc = subprocess.call(cmd, cwd=_ROOT)
    elapsed = time.perf_counter() - t0
    logger.info("  eval exit=%d (%.1fs)", rc, elapsed)
    return metrics.load_latest()


def _commit_pipeline_changes(iteration: int) -> str:
    """Stage + commit pipeline/ changes. Returns 'accept' or 'noop'.

    Reverts (for blue_stall detection) are signaled by the blue team itself when it
    detects a regression and calls `git revert` — we record that as 'revert'. M2's
    blue team writes its own CHANGELOG entry, which guarantees a non-empty commit
    when a real change was made.
    """
    diff = subprocess.run(
        ["git", "diff", "--quiet", "--", "pipeline/"], cwd=_ROOT
    ).returncode
    if diff == 0:
        return "noop"
    subprocess.run(["git", "add", "pipeline/"], cwd=_ROOT, check=True)
    msg = f"loop-iter-{iteration}: blue-team change"
    rc = subprocess.run(
        ["git", "commit", "-m", msg],
        cwd=_ROOT,
        capture_output=True,
        text=True,
    ).returncode
    return "accept" if rc == 0 else "noop"


def _print_summary(iteration: int, report, stop_reason) -> None:
    msg = (
        f"iter={iteration:<3} composite={report.composite_mean:.3f}  "
        f"pass@0.6={report.pass_rate_at_0_6:.1%}  "
        f"regressions={len(report.regressions)}  "
        f"recoveries={len(report.recoveries)}  "
        f"usd={report.cost.usd_spent:.4f}"
    )
    if stop_reason:
        msg += f"  STOP={stop_reason}"
    print(msg)


if __name__ == "__main__":
    raise SystemExit(main())
