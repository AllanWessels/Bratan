"""Run the pipeline against every test case and write a structured report.

Inputs:
- /test_cases/seed.jsonl + /test_cases/generated/*.jsonl (all cases)
- bratan.config.yaml (user-owned)
- pipeline/config.yaml (blue-team-owned; the pipeline reads this itself)

Outputs:
- /reports/run-<ts>.json  (full IterationReport)
- /reports/latest.json    (copy of above)
- /reports/regressions.md (appended human-readable list)

Usage:
    uv run python scripts/eval.py
    uv run python scripts/eval.py --mode prejudge --iteration 7
    uv run python scripts/eval.py --case-ids seed-001 seed-014
    uv run python scripts/eval.py --subset 10              # K most-informative cases
    uv run python scripts/eval.py --drift-check            # re-grade history at end
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from pipeline import cache as cache_mod  # noqa: E402
from pipeline import judge as judge_mod  # noqa: E402
from pipeline import metrics  # noqa: E402
from pipeline import query as pipeline_query  # noqa: E402
from pipeline.budget import (  # noqa: E402
    _USD_PER_INPUT_TOKEN,  # re-exported for backwards-compat callers
    _USD_PER_OUTPUT_TOKEN,
    BudgetTracker,
)
from ui.backend.config_store import load as load_config  # noqa: E402
from ui.backend.schemas import Passage, SeedCase  # noqa: E402
from ui.backend.seed_store import (  # noqa: E402 type: ignore[attr-defined]
    _read_all_cases,
    _seed_case_from_raw,
)

logger = logging.getLogger(__name__)
DEFAULT_CONFIG = _ROOT / "bratan.config.yaml"

PASS_THRESHOLD = 0.6
SUBSET_RNG_SEED = 0xCAFEBABE

__all__ = [
    "_USD_PER_INPUT_TOKEN",
    "_USD_PER_OUTPUT_TOKEN",
    "main",
    "select_informative_subset",
]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--mode", choices=["oracle", "prejudge"], default="oracle",
        help="Which judge to use. Reports written to /reports/ should be oracle.",
    )
    p.add_argument("--iteration", type=int, default=0, help="Iteration index for the report.")
    p.add_argument("--k", type=int, default=5, help="Top-k for retrieval (default 5).")
    p.add_argument(
        "--case-ids", nargs="+", default=None,
        help="Restrict eval to these case ids. Default: all cases.",
    )
    p.add_argument(
        "--subset", type=int, default=None,
        help="Run on the N most-informative cases (near-threshold or recently-flipped).",
    )
    p.add_argument(
        "--budget-usd", type=float, default=None,
        help="Abort early if total spend exceeds this dollar amount.",
    )
    p.add_argument(
        "--drift-check", action="store_true",
        help="At end of run, re-grade 5 random historical pairs and report disagreement.",
    )
    args = p.parse_args()

    if args.mode == "prejudge":
        logger.warning(
            "Running in prejudge mode — DO NOT treat the resulting report as authoritative. "
            "Reports written to /reports/ are expected to be oracle-graded."
        )

    cache_mod.reset_stats()

    cfg = load_config(DEFAULT_CONFIG)
    cases = _gather_cases(args.case_ids)
    if not cases:
        print("No cases to evaluate. Author some via the UI first.", file=sys.stderr)
        return 2

    if args.subset is not None and args.subset > 0:
        cases = select_informative_subset(cases, args.subset, metrics.load_latest())
        logger.info("Subset eval: %d most-informative cases selected", len(cases))

    logger.info("Evaluating %d cases in %s mode", len(cases), args.mode)

    verdicts = []
    retrieval_latencies: list[float] = []
    generation_latencies: list[float] = []
    budget = BudgetTracker()
    budget_hit = False

    for i, case in enumerate(cases, 1):
        t0 = time.perf_counter()
        result = pipeline_query.answer(cfg, case.question, k=args.k)
        gen_latency = float(result.get("latency_ms", 0.0))
        retrieved: list[Passage] = result.get("retrieved") or []
        retrieval_latencies.append(gen_latency)  # we don't yet split retrieval vs generation
        generation_latencies.append(gen_latency)

        # Count answer-generation token usage on the budget too (oracle-priced).
        gen_in = int(result.get("tokens_in", 0) or 0)
        gen_out = int(result.get("tokens_out", 0) or 0)
        if gen_in or gen_out:
            budget.add_cost(gen_in, gen_out, judge_mode="oracle")

        verdict = judge_mod.judge(case, result.get("answer"), retrieved, cfg, mode=args.mode)
        verdicts.append(verdict)
        budget.add(verdict)

        elapsed = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "  [%d/%d] %s composite=%.2f recall=%.2f (case latency %.0fms)",
            i, len(cases), case.id, verdict.composite, verdict.retrieval_recall_at_5, elapsed,
        )

        if budget.aborted_for_budget(args.budget_usd):
            logger.warning(
                "budget hit ($%.2f >= $%.2f) — stopping eval early",
                budget.usd_spent, args.budget_usd,
            )
            budget_hit = True
            break

    drift_block: metrics.DriftBlock | None = None
    if args.drift_check:
        try:
            drift_block = judge_mod.drift_check(cfg, n_samples=5)
            logger.info(
                "drift_check: %d samples re-graded, disagreement_rate=%.1f%%",
                drift_block.samples_checked, drift_block.disagreement_rate * 100,
            )
        except Exception as exc:
            logger.warning("drift_check failed: %s", exc)

    previous = metrics.load_latest()
    report = metrics.build_report(
        iteration=args.iteration,
        cfg=cfg,
        cases=cases,
        verdicts=verdicts,
        retrieval_latencies_ms=retrieval_latencies,
        generation_latencies_ms=generation_latencies,
        usd_spent=budget.usd_spent,
        cache_hits=cache_mod.CACHE_STATS["hits"],
        drift=drift_block,
        previous=previous,
        stop_reason="budget" if budget_hit else None,
    )

    target = metrics.write_report(report)
    metrics.append_regressions_md(report)

    print(
        f"\nWrote {target.relative_to(_ROOT)}  composite={report.composite_mean:.3f}  "
        f"pass@0.6={report.pass_rate_at_0_6:.1%}  "
        f"regressions={len(report.regressions)}  "
        f"recoveries={len(report.recoveries)}  "
        f"usd={report.cost.usd_spent:.4f}  "
        f"cache_hits={report.cost.cache_hits}"
    )
    if budget_hit:
        return 3
    return 0


def _gather_cases(restrict: list[str] | None) -> list[SeedCase]:
    cases = list(_read_all_cases())

    gen_dir = _ROOT / "test_cases" / "generated"
    if gen_dir.exists():
        for fp in sorted(gen_dir.glob("*.jsonl")):
            for line in fp.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    cases.append(_seed_case_from_raw(json.loads(line)))
                except Exception as exc:
                    logger.warning("Skipping malformed generated row in %s: %s", fp.name, exc)

    if restrict is not None:
        keep = set(restrict)
        cases = [c for c in cases if c.id in keep]

    return cases


# ---------------------------------------------------------------------------
# Subset selection: which N cases are most informative for blue-team's inner loop?
# ---------------------------------------------------------------------------


def select_informative_subset(
    cases: list[SeedCase],
    n: int,
    latest_report: metrics.IterationReport | None,
) -> list[SeedCase]:
    """Pick the K most-informative cases for an inner-loop iteration.

    Heuristic, in priority order:
      1. Recently flipped — appears in `latest_report.regressions` or `recoveries`.
      2. Closest composite to the 0.6 pass threshold in `latest_report.by_case`.
      3. Unknown cases (no prior history) — included after recently-flipped.

    Tiebreak: deterministic shuffle keyed by `SUBSET_RNG_SEED`.
    """
    if n <= 0 or not cases:
        return []
    if latest_report is None:
        # No history — fall back to a deterministic random subset.
        rng = random.Random(SUBSET_RNG_SEED)
        shuffled = list(cases)
        rng.shuffle(shuffled)
        return shuffled[:n]

    case_by_id = {c.id: c for c in cases}
    flipped_ids = (
        {r.case_id for r in latest_report.regressions}
        | set(latest_report.recoveries)
    )
    composite_by_id = {row.case_id: row.composite for row in latest_report.by_case}

    flipped: list[SeedCase] = []
    near_threshold: list[tuple[float, SeedCase]] = []
    unknown: list[SeedCase] = []

    for c in cases:
        if c.id in flipped_ids:
            flipped.append(c)
            continue
        comp = composite_by_id.get(c.id)
        if comp is None:
            unknown.append(c)
        else:
            near_threshold.append((abs(comp - PASS_THRESHOLD), c))

    rng = random.Random(SUBSET_RNG_SEED)
    rng.shuffle(flipped)
    rng.shuffle(unknown)
    near_threshold.sort(key=lambda kv: kv[0])

    ordered: list[SeedCase] = []
    seen: set[str] = set()

    def _push(seq):  # type: ignore[no-untyped-def]
        for c in seq:
            if c.id in seen:
                continue
            if c.id not in case_by_id:
                continue
            ordered.append(c)
            seen.add(c.id)
            if len(ordered) >= n:
                return True
        return False

    if _push(flipped):
        return ordered
    if _push(c for _d, c in near_threshold):
        return ordered
    _push(unknown)
    return ordered


if __name__ == "__main__":
    raise SystemExit(main())
