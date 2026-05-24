"""Per-iteration token + USD counters.

Pure data structure — no I/O. Callers feed verdicts in (or dicts shaped like
verdicts), read a snapshot at the end of the loop, and decide whether to abort
if the configured USD limit was crossed.

USD rates live here so both `scripts/eval.py` and any future caller (e.g.
`scripts/sweep.py`) share one source of truth. Local prejudge calls are
counted as $0; oracle calls are priced at Sonnet 4 list prices.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Anthropic Sonnet 4 list pricing (per token, May 2026).
_USD_PER_INPUT_TOKEN: float = 3.0 / 1_000_000
_USD_PER_OUTPUT_TOKEN: float = 15.0 / 1_000_000


def estimate_usd(judge_mode: str, tokens_in: int, tokens_out: int) -> float:
    """Convert token counts into USD for the given judge mode.

    Local `prejudge` calls count as zero (no API cost). Anything else is
    priced at the oracle rate; that includes the answer-generation call in
    `pipeline.query` even though it isn't a "judge" call per se.
    """
    if judge_mode == "prejudge":
        return 0.0
    return tokens_in * _USD_PER_INPUT_TOKEN + tokens_out * _USD_PER_OUTPUT_TOKEN


@dataclass
class BudgetTracker:
    """Accumulates token + USD spend across a single eval run."""

    tokens_in: int = 0
    tokens_out: int = 0
    usd_spent: float = 0.0
    oracle_calls: int = 0
    prejudge_calls: int = 0
    extra: dict[str, int] = field(default_factory=dict)

    def add(self, verdict: Any) -> None:
        """Accept a `JudgeVerdict` or a dict with `tokens_in/tokens_out/judge_mode`.

        Anything resembling the verdict shape works — duck-typing via attribute
        lookup, falling back to `dict.get` if attrs aren't present.
        """
        tokens_in = _coerce_int(_pluck(verdict, "tokens_in", 0))
        tokens_out = _coerce_int(_pluck(verdict, "tokens_out", 0))
        judge_mode = str(_pluck(verdict, "judge_mode", "oracle"))

        self.tokens_in += tokens_in
        self.tokens_out += tokens_out
        if judge_mode == "oracle":
            self.oracle_calls += 1
        elif judge_mode == "prejudge":
            self.prejudge_calls += 1

        self.usd_spent += estimate_usd(judge_mode, tokens_in, tokens_out)

    def add_cost(self, tokens_in: int, tokens_out: int, judge_mode: str = "oracle") -> None:
        """Direct accumulator for non-verdict spend (e.g. answer-generation calls)."""
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out
        if judge_mode == "oracle":
            self.oracle_calls += 1
        elif judge_mode == "prejudge":
            self.prejudge_calls += 1
        self.usd_spent += estimate_usd(judge_mode, tokens_in, tokens_out)

    def snapshot(self) -> dict[str, Any]:
        return {
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "usd_spent": self.usd_spent,
            "oracle_calls": self.oracle_calls,
            "prejudge_calls": self.prejudge_calls,
        }

    def aborted_for_budget(self, limit_usd: float | None) -> bool:
        """True iff a non-None limit was set and current spend equals or exceeds it."""
        if limit_usd is None:
            return False
        return self.usd_spent >= limit_usd


def _pluck(obj: Any, key: str, default: Any) -> Any:
    if hasattr(obj, key):
        return getattr(obj, key)
    if isinstance(obj, dict):
        return obj.get(key, default)
    return default


def _coerce_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0
