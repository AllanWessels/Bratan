"""Score one seed case end-to-end.

Used by the red team to verify a candidate case actually fails (or passes), and
by humans to debug a single bad answer.

Usage:
    uv run python scripts/eval_single.py --case-id seed-001
    uv run python scripts/eval_single.py --case-id seed-001 --mode prejudge
    uv run python scripts/eval_single.py --case-id seed-001 --json   # machine-readable
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

# When run as a script, /scripts/ isn't on sys.path. Insert the project root.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from pipeline import judge as judge_mod  # noqa: E402
from pipeline import query as pipeline_query  # noqa: E402
from ui.backend.config_store import load as load_config  # noqa: E402
from ui.backend.schemas import BratanConfig, Passage, SeedCase  # noqa: E402
from ui.backend.seed_store import _read_all_cases  # noqa: E402 type: ignore[attr-defined]

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "bratan.config.yaml"


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    p = argparse.ArgumentParser(description="Score one seed case through the pipeline.")
    p.add_argument("--case-id", required=True, help="Case id from seed.jsonl or generated/*.jsonl")
    p.add_argument(
        "--mode",
        choices=["oracle", "prejudge"],
        default="oracle",
        help="Which judge to use. Defaults to oracle.",
    )
    p.add_argument("--k", type=int, default=5, help="Top-k for retrieval (default 5).")
    p.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Emit a machine-readable JSON object. Default is a human summary.",
    )
    args = p.parse_args()

    cfg = load_config(DEFAULT_CONFIG)
    if not cfg.setup_completed:
        print("warning: setup wizard has not been completed; using defaults", file=sys.stderr)

    case = _find_case(args.case_id)
    if case is None:
        print(f"error: case id {args.case_id!r} not found in seed.jsonl or generated/", file=sys.stderr)
        return 2

    result = pipeline_query.answer(cfg, case.question, k=args.k)
    answer_text = result.get("answer")
    retrieved: list[Passage] = result.get("retrieved") or []
    pipeline_latency_ms = float(result.get("latency_ms", 0.0))

    verdict = judge_mod.judge(case, answer_text, retrieved, cfg, mode=args.mode)

    payload = {
        "case_id": case.id,
        "question": case.question,
        "ground_truth": case.ground_truth,
        "failure_category": case.failure_category.value,
        "pipeline": {
            "model": result.get("model"),
            "warning": result.get("warning"),
            "latency_ms": pipeline_latency_ms,
            "answer": answer_text,
            "retrieved": [r.model_dump() for r in retrieved],
        },
        "verdict": verdict.model_dump(),
        "evaluated_at": datetime.now(UTC).isoformat(),
    }

    if args.as_json:
        print(json.dumps(payload, indent=2))
    else:
        _print_human(payload)

    # exit code mirrors red team's threshold: 0 = case passes (composite >= 0.6),
    # 1 = case fails (good candidate for the test set).
    return 0 if verdict.composite >= 0.6 else 1


def _find_case(case_id: str) -> SeedCase | None:
    for case in _read_all_cases():
        if case.id == case_id:
            return case
    gen_dir = ROOT / "test_cases" / "generated"
    if gen_dir.exists():
        for fp in sorted(gen_dir.glob("*.jsonl")):
            for line in fp.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("id") == case_id:
                    from ui.backend.seed_store import _seed_case_from_raw  # type: ignore[attr-defined]

                    return _seed_case_from_raw(obj)
    return None


def _print_human(payload: dict) -> None:
    v = payload["verdict"]
    print(f"case      {payload['case_id']}  [{payload['failure_category']}]")
    print(f"question  {payload['question']}")
    print(f"truth     {payload['ground_truth']}")
    print()
    p = payload["pipeline"]
    if p.get("warning"):
        print(f"pipeline  WARNING: {p['warning']}")
    print(f"model     {p.get('model') or '(none)'}   latency {p['latency_ms']:.0f}ms")
    print(f"retrieved {len(p['retrieved'])} chunks")
    print()
    print(f"answer    {p['answer'] or '(none)'}")
    print()
    correctness = v.get("answer_correctness")
    faithfulness = v.get("faithfulness")
    print(
        f"verdict   composite={v['composite']:.2f}  recall@5={v['retrieval_recall_at_5']:.2f}  "
        f"correctness={correctness}  faithfulness={faithfulness}  ({v['judge_mode']}/{v['model_used']})"
    )
    if v.get("correctness_reason"):
        print(f"  correctness: {v['correctness_reason']}")
    if v.get("faithfulness_reason"):
        print(f"  faithfulness: {v['faithfulness_reason']}")
    if v.get("unsupported_claims"):
        print(f"  unsupported_claims: {v['unsupported_claims']}")
    if v.get("fabricated_citations"):
        print(f"  fabricated_citations: {v['fabricated_citations']}")
    if v.get("low_confidence_reasons"):
        print(f"  low_confidence: {v['low_confidence_reasons']}")


if __name__ == "__main__":
    raise SystemExit(main())
