"""Shared hyperparameter-sweep runner.

The four optimization-method skills (ablation / grid-sweep /
bayesian-optimization / particle-swarm) all defer to this script. It exposes a
small uniform interface: name the parameter(s), choose a search strategy,
evaluate each candidate on the prejudge against a subset, oracle-validate the
winner, and persist only if the winner actually beats the incumbent.

Usage examples
--------------

Grid sweep over a single parameter (the simplest case):

    uv run python scripts/sweep.py \\
        --param retrieval.vector.k --grid 5,10,20,40 \\
        --strategy grid --subset 10 --judge prejudge

Cartesian grid over two parameters:

    uv run python scripts/sweep.py \\
        --param retrieval.vector.k --grid 5,10,20 \\
        --param retrieval.reranker.top_n --grid 3,5,10 \\
        --strategy grid --subset 10

Bayesian optimization over a numeric parameter (requires `optuna`):

    uv run python scripts/sweep.py \\
        --param retrieval.vector.k --range 4:40:int \\
        --strategy bayesian --n-trials 25 --subset 10

Ablation pass — disable one stage at a time and compare to the incumbent:

    uv run python scripts/sweep.py --strategy ablation \\
        --stages retrieval.reranker.enabled,verification.enabled \\
        --subset 10

The runner ALWAYS validates the winner with a full oracle eval before
persisting to ``pipeline/config.yaml``. A regression on the oracle check
discards the result and prints a low-confidence warning.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import logging
import random
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from pipeline import metrics  # noqa: E402
from ui.backend.config_store import load as load_config  # noqa: E402

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = _ROOT / "bratan.config.yaml"
PIPELINE_CONFIG = _ROOT / "pipeline" / "config.yaml"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    """One point in the search space."""

    params: dict[str, Any]

    def label(self) -> str:
        return ",".join(f"{k}={v}" for k, v in self.params.items())


@dataclass
class TrialResult:
    candidate: Candidate
    composite_mean: float
    pass_rate_at_0_6: float
    judge: str  # "prejudge" or "oracle"
    raw_report_path: Path | None = None


# ---------------------------------------------------------------------------
# Pipeline-config read/write
# ---------------------------------------------------------------------------


def _load_pipeline_yaml() -> dict[str, Any]:
    if not PIPELINE_CONFIG.exists():
        return {}
    return yaml.safe_load(PIPELINE_CONFIG.read_text(encoding="utf-8")) or {}


def _write_pipeline_yaml(data: dict[str, Any]) -> None:
    PIPELINE_CONFIG.write_text(
        yaml.safe_dump(data, sort_keys=False, default_flow_style=False),
        encoding="utf-8",
    )


def _set_nested(d: dict[str, Any], dotted_key: str, value: Any) -> None:
    parts = dotted_key.split(".")
    cur = d
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def _get_nested(d: dict[str, Any], dotted_key: str) -> Any:
    parts = dotted_key.split(".")
    cur: Any = d
    for p in parts:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


# ---------------------------------------------------------------------------
# Trial evaluation — subprocess out to scripts/eval.py
# ---------------------------------------------------------------------------


def _run_trial(candidate: Candidate, *, subset: int | None, judge: str) -> TrialResult:
    """Apply candidate's params, run eval, restore the original config."""
    snapshot = _load_pipeline_yaml()
    applied = dict(snapshot)  # shallow; nested writes need a deeper copy
    applied = json.loads(json.dumps(snapshot))  # deep copy via JSON
    for k, v in candidate.params.items():
        _set_nested(applied, k, v)
    _write_pipeline_yaml(applied)

    try:
        cmd = [
            sys.executable,
            str(_ROOT / "scripts" / "eval.py"),
            "--mode",
            judge,
        ]
        if subset is not None:
            cmd.extend(["--subset", str(subset)])
        logger.info("trial: %s  cmd: %s", candidate.label(), " ".join(cmd[-4:]))
        rc = subprocess.call(cmd, cwd=_ROOT)
        if rc not in (0, 3):  # 0 = ok, 3 = budget abort (still has a report)
            logger.warning("trial failed with rc=%d", rc)
        report = metrics.load_latest()
        if report is None:
            return TrialResult(candidate, 0.0, 0.0, judge)
        return TrialResult(
            candidate=candidate,
            composite_mean=report.composite_mean,
            pass_rate_at_0_6=report.pass_rate_at_0_6,
            judge=judge,
        )
    finally:
        _write_pipeline_yaml(snapshot)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


def _grid_candidates(grids: dict[str, list[Any]]) -> list[Candidate]:
    keys = list(grids.keys())
    rows = list(itertools.product(*(grids[k] for k in keys)))
    return [Candidate(dict(zip(keys, row))) for row in rows]


def _ablation_candidates(stages: list[str], incumbent: dict[str, Any]) -> list[Candidate]:
    """For each stage flag, emit a candidate that disables ONLY that stage.

    Incumbent itself is included as the first candidate so its score is the baseline.
    """
    out: list[Candidate] = [Candidate({})]  # baseline (no change)
    for stage in stages:
        cur = _get_nested(incumbent, stage)
        if cur is None:
            logger.warning("stage %s not present in pipeline config; skipping", stage)
            continue
        out.append(Candidate({stage: False}))
    return out


def _bayesian_search(
    param: str,
    low: float,
    high: float,
    cast: str,
    n_trials: int,
    *,
    subset: int | None,
    judge: str,
) -> list[TrialResult]:
    try:
        import optuna  # type: ignore[import-not-found]
    except ImportError:
        raise SystemExit(
            "Bayesian strategy requires optuna. Install with: uv add optuna"
        )

    results: list[TrialResult] = []

    def objective(trial: "optuna.Trial") -> float:
        if cast == "int":
            v: Any = trial.suggest_int(param, int(low), int(high))
        elif cast == "logfloat":
            v = trial.suggest_float(param, low, high, log=True)
        else:
            v = trial.suggest_float(param, low, high)
        cand = Candidate({param: v})
        r = _run_trial(cand, subset=subset, judge=judge)
        results.append(r)
        return r.composite_mean

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_range(spec: str) -> tuple[float, float, str]:
    """`4:40:int` -> (4, 40, 'int'); `0.01:1.0:logfloat` -> (0.01, 1.0, 'logfloat')."""
    parts = spec.split(":")
    if len(parts) not in (2, 3):
        raise argparse.ArgumentTypeError(f"--range must be lo:hi[:cast], got {spec!r}")
    lo, hi = float(parts[0]), float(parts[1])
    cast = parts[2] if len(parts) == 3 else "float"
    if cast not in ("int", "float", "logfloat"):
        raise argparse.ArgumentTypeError(f"unsupported cast {cast!r}")
    return lo, hi, cast


def _parse_grid_values(raw: str) -> list[Any]:
    out: list[Any] = []
    for v in raw.split(","):
        v = v.strip()
        try:
            out.append(int(v))
        except ValueError:
            try:
                out.append(float(v))
            except ValueError:
                out.append(v)
    return out


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument(
        "--strategy",
        choices=["grid", "bayesian", "ablation"],
        default="grid",
    )
    p.add_argument(
        "--param",
        action="append",
        default=[],
        help="Dotted key into pipeline/config.yaml (repeatable for grid)",
    )
    p.add_argument(
        "--grid",
        action="append",
        default=[],
        help="Comma-separated values, one per --param (grid strategy only)",
    )
    p.add_argument(
        "--range",
        type=_parse_range,
        default=None,
        help="Range spec lo:hi[:cast] (bayesian strategy; cast in int|float|logfloat)",
    )
    p.add_argument("--n-trials", type=int, default=20, help="Bayesian: trials to run")
    p.add_argument(
        "--stages",
        default="",
        help="Ablation: comma-separated dotted boolean flags to disable one at a time",
    )
    p.add_argument(
        "--subset",
        type=int,
        default=None,
        help="Use scripts/eval.py --subset N for inner-loop trials",
    )
    p.add_argument(
        "--judge",
        choices=["oracle", "prejudge"],
        default="prejudge",
        help="Inner-loop trial judge (winner is always oracle-validated)",
    )
    p.add_argument(
        "--out",
        default=None,
        help="Path to write trial CSV (default: reports/sweep-<ts>.csv)",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Tiebreak randomization seed",
    )
    p.add_argument(
        "--no-persist",
        action="store_true",
        help="Print the winner but do not write it to pipeline/config.yaml",
    )
    args = p.parse_args()
    random.seed(args.seed)

    cfg = load_config(DEFAULT_CONFIG)
    incumbent = _load_pipeline_yaml()

    # Build candidates per strategy.
    candidates: list[Candidate] = []
    if args.strategy == "grid":
        if len(args.param) != len(args.grid):
            raise SystemExit("grid: must provide one --grid per --param")
        grids = {
            args.param[i]: _parse_grid_values(args.grid[i]) for i in range(len(args.param))
        }
        candidates = _grid_candidates(grids)
    elif args.strategy == "ablation":
        if not args.stages:
            raise SystemExit("ablation: --stages is required")
        stages = [s.strip() for s in args.stages.split(",") if s.strip()]
        candidates = _ablation_candidates(stages, incumbent)
    elif args.strategy == "bayesian":
        if len(args.param) != 1 or args.range is None:
            raise SystemExit("bayesian: requires exactly one --param and one --range")
        lo, hi, cast = args.range
        trial_results = _bayesian_search(
            args.param[0], lo, hi, cast, args.n_trials,
            subset=args.subset, judge=args.judge,
        )
        results = trial_results
    else:
        raise SystemExit(f"unknown strategy {args.strategy}")

    if args.strategy in ("grid", "ablation"):
        if not candidates:
            print("no candidates produced; nothing to do", file=sys.stderr)
            return 2
        results = [_run_trial(c, subset=args.subset, judge=args.judge) for c in candidates]

    # Emit CSV.
    out_path = (
        Path(args.out)
        if args.out
        else _ROOT / "reports" / f"sweep-{__import__('datetime').datetime.now().strftime('%Y%m%dT%H%M%SZ')}.csv"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["candidate", "composite_mean", "pass_rate_at_0_6", "judge"])
        for r in results:
            w.writerow([r.candidate.label() or "(baseline)", r.composite_mean, r.pass_rate_at_0_6, r.judge])
    print(f"sweep results: {out_path.relative_to(_ROOT)}")

    # Pick the winner.
    if not results:
        print("no trials produced results", file=sys.stderr)
        return 2
    winner = max(results, key=lambda r: r.composite_mean)
    print(f"winner (subset/{args.judge}): {winner.candidate.label() or '(baseline)'}  composite={winner.composite_mean:.3f}")

    if not winner.candidate.params:
        print("winner is the incumbent — no change to persist")
        return 0

    # Oracle-validate the winner.
    print("oracle-validating winner...")
    oracle = _run_trial(winner.candidate, subset=None, judge="oracle")
    incumbent_oracle = _run_trial(Candidate({}), subset=None, judge="oracle")
    print(
        f"  oracle composite: winner={oracle.composite_mean:.3f}  incumbent={incumbent_oracle.composite_mean:.3f}"
    )
    if oracle.composite_mean <= incumbent_oracle.composite_mean:
        print("  oracle disagreed — discarding (low-confidence prejudge signal)")
        return 0

    if args.no_persist:
        print("  --no-persist set; not modifying pipeline/config.yaml")
        return 0

    applied = json.loads(json.dumps(incumbent))
    for k, v in winner.candidate.params.items():
        _set_nested(applied, k, v)
    _write_pipeline_yaml(applied)
    print(f"  persisted: {winner.candidate.label()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
