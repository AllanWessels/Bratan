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
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from pipeline import judge as judge_mod  # noqa: E402
from pipeline import metrics  # noqa: E402
from pipeline import query as pipeline_query  # noqa: E402
from ui.backend.config_store import load as load_config  # noqa: E402
from ui.backend.schemas import BratanConfig, Passage, SeedCase  # noqa: E402
from ui.backend.seed_store import _read_all_cases, _seed_case_from_raw  # noqa: E402 type: ignore[attr-defined]

logger = logging.getLogger(__name__)
DEFAULT_CONFIG = _ROOT / "bratan.config.yaml"


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
        "--budget-usd", type=float, default=None,
        help="Abort early if total spend exceeds this dollar amount.",
    )
    args = p.parse_args()

    if args.mode == "prejudge":
        logger.warning(
            "Running in prejudge mode — DO NOT treat the resulting report as authoritative. "
            "Reports written to /reports/ are expected to be oracle-graded."
        )

    cfg = load_config(DEFAULT_CONFIG)
    cases = _gather_cases(args.case_ids)
    if not cases:
        print("No cases to evaluate. Author some via the UI first.", file=sys.stderr)
        return 2

    logger.info("Evaluating %d cases in %s mode", len(cases), args.mode)

    verdicts = []
    retrieval_latencies: list[float] = []
    generation_latencies: list[float] = []
    cost_usd = 0.0
    budget_hit = False

    for i, case in enumerate(cases, 1):
        t0 = time.perf_counter()
        result = pipeline_query.answer(cfg, case.question, k=args.k)
        gen_latency = float(result.get("latency_ms", 0.0))
        retrieved: list[Passage] = result.get("retrieved") or []
        retrieval_latencies.append(gen_latency)  # we don't yet split retrieval vs generation
        generation_latencies.append(gen_latency)

        verdict = judge_mod.judge(case, result.get("answer"), retrieved, cfg, mode=args.mode)
        verdicts.append(verdict)

        cost_usd += _estimate_usd(verdict, cfg)
        elapsed = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "  [%d/%d] %s composite=%.2f recall=%.2f (case latency %.0fms)",
            i, len(cases), case.id, verdict.composite, verdict.retrieval_recall_at_5, elapsed,
        )

        if args.budget_usd is not None and cost_usd >= args.budget_usd:
            logger.warning("budget hit ($%.2f >= $%.2f) — stopping eval early", cost_usd, args.budget_usd)
            budget_hit = True
            break

    previous = metrics.load_latest()
    report = metrics.build_report(
        iteration=args.iteration,
        cfg=cfg,
        cases=cases,
        verdicts=verdicts,
        retrieval_latencies_ms=retrieval_latencies,
        generation_latencies_ms=generation_latencies,
        usd_spent=cost_usd,
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
        f"usd={report.cost.usd_spent:.4f}"
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


# Rough USD estimate for Anthropic Sonnet 4 calls.
# Per current pricing (~$3/MTok in, ~$15/MTok out). Local prejudge counted as $0.
_USD_PER_INPUT_TOKEN = 3.0 / 1_000_000
_USD_PER_OUTPUT_TOKEN = 15.0 / 1_000_000


def _estimate_usd(verdict, cfg: BratanConfig) -> float:
    if verdict.judge_mode != "oracle":
        return 0.0
    return verdict.tokens_in * _USD_PER_INPUT_TOKEN + verdict.tokens_out * _USD_PER_OUTPUT_TOKEN


if __name__ == "__main__":
    raise SystemExit(main())
