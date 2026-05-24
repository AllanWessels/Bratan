"""Unit tests for pipeline.budget — token + USD tracking."""

from __future__ import annotations

import pytest

from pipeline.budget import (
    _USD_PER_INPUT_TOKEN,
    _USD_PER_OUTPUT_TOKEN,
    BudgetTracker,
    estimate_usd,
)


class _FakeVerdict:
    def __init__(self, tokens_in: int, tokens_out: int, judge_mode: str = "oracle") -> None:
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.judge_mode = judge_mode


def test_estimate_usd_oracle_uses_anthropic_rates() -> None:
    usd = estimate_usd("oracle", 1000, 500)
    expected = 1000 * _USD_PER_INPUT_TOKEN + 500 * _USD_PER_OUTPUT_TOKEN
    assert usd == pytest.approx(expected)


def test_estimate_usd_prejudge_is_free() -> None:
    assert estimate_usd("prejudge", 1_000_000, 500_000) == 0.0


def test_add_accepts_object_with_attrs() -> None:
    b = BudgetTracker()
    b.add(_FakeVerdict(100, 50, "oracle"))
    assert b.tokens_in == 100
    assert b.tokens_out == 50
    assert b.oracle_calls == 1
    assert b.prejudge_calls == 0
    assert b.usd_spent == pytest.approx(
        100 * _USD_PER_INPUT_TOKEN + 50 * _USD_PER_OUTPUT_TOKEN
    )


def test_add_accepts_dict_shape() -> None:
    b = BudgetTracker()
    b.add({"tokens_in": 10, "tokens_out": 4, "judge_mode": "prejudge"})
    assert b.tokens_in == 10
    assert b.tokens_out == 4
    assert b.prejudge_calls == 1
    assert b.oracle_calls == 0
    assert b.usd_spent == 0.0


def test_add_mixed_modes_accumulate() -> None:
    b = BudgetTracker()
    b.add(_FakeVerdict(100, 50, "oracle"))
    b.add(_FakeVerdict(200, 30, "prejudge"))
    b.add(_FakeVerdict(50, 25, "oracle"))
    snap = b.snapshot()
    assert snap["oracle_calls"] == 2
    assert snap["prejudge_calls"] == 1
    assert snap["tokens_in"] == 350
    assert snap["tokens_out"] == 105
    # Only the oracle tokens contribute to spend.
    expected = (150 * _USD_PER_INPUT_TOKEN) + (75 * _USD_PER_OUTPUT_TOKEN)
    assert snap["usd_spent"] == pytest.approx(expected)


def test_snapshot_shape() -> None:
    b = BudgetTracker()
    b.add(_FakeVerdict(10, 5))
    snap = b.snapshot()
    assert set(snap.keys()) == {
        "tokens_in", "tokens_out", "usd_spent", "oracle_calls", "prejudge_calls",
    }


def test_aborted_for_budget_none_limit_is_false() -> None:
    b = BudgetTracker()
    b.add(_FakeVerdict(1_000_000, 1_000_000))
    assert b.aborted_for_budget(None) is False


def test_aborted_for_budget_under_limit() -> None:
    b = BudgetTracker()
    b.add(_FakeVerdict(100, 50))
    assert b.aborted_for_budget(10.0) is False


def test_aborted_for_budget_over_limit() -> None:
    b = BudgetTracker()
    # 1M input * $3/M + 1M output * $15/M = $18
    b.add(_FakeVerdict(1_000_000, 1_000_000))
    assert b.aborted_for_budget(5.0) is True


def test_add_cost_direct() -> None:
    b = BudgetTracker()
    b.add_cost(1000, 200, judge_mode="oracle")
    assert b.oracle_calls == 1
    assert b.usd_spent > 0


def test_missing_fields_default_to_zero() -> None:
    b = BudgetTracker()
    b.add({})  # nothing — default to oracle, zero tokens
    snap = b.snapshot()
    assert snap["tokens_in"] == 0
    assert snap["tokens_out"] == 0
    assert snap["usd_spent"] == 0.0
    assert snap["oracle_calls"] == 1
