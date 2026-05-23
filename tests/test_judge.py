"""Unit tests for pipeline.judge.

LLM calls are patched out. Real prompt rendering is exercised; real recall@5 math
is exercised; real composite math is exercised.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from pipeline.judge import (
    JudgeVerdict,
    _hash_weights,
    _parse_score_json,
    judge,
    oracle_judge,
    prejudge,
    recall_at_5,
)
from ui.backend.schemas import (
    BratanConfig,
    FailureCategory,
    JudgeWeights,
    ModelConfig,
    Passage,
    PassageRef,
    SeedCase,
)


def _make_case(
    *,
    source_passages: list[PassageRef] | None = None,
    question: str = "What does the fox jump over?",
    ground_truth: str = "the lazy dog",
) -> SeedCase:
    return SeedCase(
        id="case-1",
        question=question,
        ground_truth=ground_truth,
        source_passages=source_passages
        if source_passages is not None
        else [PassageRef(path="fox.md", line_start=3, line_end=5)],
        failure_category=FailureCategory.STRAIGHTFORWARD,
        created_at=datetime.now(UTC),
        created_by="human",
    )


def _passage(path: str, ls: int, le: int, content: str = "...") -> Passage:
    return Passage(path=path, line_start=ls, line_end=le, content=content, score=0.9)


# ---------------------------------------------------------------------------
# recall@5
# ---------------------------------------------------------------------------


def test_recall_at_5_full_hit_overlap() -> None:
    case = _make_case(
        source_passages=[
            PassageRef(path="a.md", line_start=10, line_end=20),
            PassageRef(path="b.md", line_start=5, line_end=8),
        ]
    )
    retrieved = [
        _passage("a.md", 15, 25),  # overlaps a.md:10-20
        _passage("b.md", 5, 8),    # exact
        _passage("c.md", 1, 100),  # not relevant
    ]
    assert recall_at_5(case, retrieved) == 1.0


def test_recall_at_5_partial() -> None:
    case = _make_case(
        source_passages=[
            PassageRef(path="a.md", line_start=10, line_end=20),
            PassageRef(path="b.md", line_start=5, line_end=8),
        ]
    )
    retrieved = [_passage("a.md", 15, 25)]
    assert recall_at_5(case, retrieved) == 0.5


def test_recall_at_5_only_top_5_count() -> None:
    case = _make_case(
        source_passages=[PassageRef(path="a.md", line_start=10, line_end=20)]
    )
    retrieved = [_passage("z.md", 0, 1)] * 5 + [_passage("a.md", 10, 20)]
    # the matching passage is the 6th — outside top-5
    assert recall_at_5(case, retrieved) == 0.0


def test_recall_at_5_no_passages_returns_one() -> None:
    """Out-of-scope cases want a refusal; nothing to retrieve = full recall."""
    case = _make_case(source_passages=[])
    assert recall_at_5(case, []) == 1.0


# ---------------------------------------------------------------------------
# JSON parser tolerance
# ---------------------------------------------------------------------------


def test_parse_score_json_plain() -> None:
    assert _parse_score_json('{"score": 1.0, "reason": "ok"}') == {
        "score": 1.0,
        "reason": "ok",
    }


def test_parse_score_json_with_prose() -> None:
    raw = 'Here is my verdict:\n{"score": 0.5, "reason": "partial"}\nDone.'
    parsed = _parse_score_json(raw)
    assert parsed["score"] == 0.5


def test_parse_score_json_returns_empty_on_garbage() -> None:
    assert _parse_score_json("no json here") == {}


# ---------------------------------------------------------------------------
# Oracle path: no API key → recall-only composite + low_confidence reason
# ---------------------------------------------------------------------------


def test_oracle_judge_no_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cfg = BratanConfig(models=ModelConfig(anthropic_api_key=""))
    case = _make_case()
    retrieved = [_passage("fox.md", 3, 5)]

    v = oracle_judge(case, "the lazy dog", retrieved, cfg)

    assert isinstance(v, JudgeVerdict)
    assert v.judge_mode == "oracle"
    assert v.answer_correctness is None
    assert v.faithfulness is None
    assert v.retrieval_recall_at_5 == 1.0
    # composite is just w_recall * 1.0 with default weights 0.3
    assert v.composite == pytest.approx(0.3, abs=1e-6)
    assert "no_anthropic_api_key" in v.low_confidence_reasons


# ---------------------------------------------------------------------------
# Prejudge path: no vLLM URL → low_confidence
# ---------------------------------------------------------------------------


def test_prejudge_no_vllm_url() -> None:
    cfg = BratanConfig(models=ModelConfig(vllm_base_url=""))
    case = _make_case()
    retrieved = [_passage("fox.md", 3, 5)]

    v = prejudge(case, "any answer", retrieved, cfg)

    assert v.judge_mode == "prejudge"
    assert v.answer_correctness is None
    assert "no_vllm_base_url" in v.low_confidence_reasons


# ---------------------------------------------------------------------------
# Happy path: mocked oracle returns valid grading JSON
# ---------------------------------------------------------------------------


def test_oracle_judge_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cfg = BratanConfig()
    case = _make_case()
    retrieved = [_passage("fox.md", 3, 5, content="The fox jumps over the lazy dog.")]

    calls: list[str] = []

    def fake_call(api_key: str, model: str, prompt: str) -> tuple[str, int, int]:
        if "<ground_truth>" in prompt:
            calls.append("correctness")
            return ('{"score": 1.0, "reason": "exact match", "low_confidence": false}', 100, 20)
        calls.append("faithfulness")
        return (
            '{"score": 1.0, "unsupported_claims": [], "fabricated_citations": [], '
            '"reason": "all supported", "low_confidence": false}',
            150,
            25,
        )

    with patch("pipeline.judge._call_anthropic", side_effect=fake_call):
        v = oracle_judge(case, "the lazy dog", retrieved, cfg)

    assert calls == ["correctness", "faithfulness"]
    assert v.answer_correctness == 1.0
    assert v.faithfulness == 1.0
    assert v.retrieval_recall_at_5 == 1.0
    # composite = 0.4*1 + 0.3*1 + 0.3*1 = 1.0
    assert v.composite == pytest.approx(1.0, abs=1e-6)
    assert v.tokens_in == 250
    assert v.tokens_out == 45
    assert v.unsupported_claims == []
    assert v.fabricated_citations == []
    assert v.low_confidence_reasons == []
    assert v.model_used == cfg.models.oracle_model


def test_oracle_judge_partial_faithfulness(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cfg = BratanConfig()
    case = _make_case()
    retrieved = [_passage("fox.md", 3, 5)]

    def fake_call(api_key: str, model: str, prompt: str) -> tuple[str, int, int]:
        if "<ground_truth>" in prompt:
            return ('{"score": 0.5, "reason": "missing qualifier"}', 100, 20)
        return (
            '{"score": 0.0, "unsupported_claims": ["claim X"], '
            '"fabricated_citations": ["[bogus.md:1-2]"], "reason": "ungrounded"}',
            150,
            25,
        )

    with patch("pipeline.judge._call_anthropic", side_effect=fake_call):
        v = oracle_judge(case, "answer", retrieved, cfg)

    # composite = 0.4*0.5 + 0.3*1.0 + 0.3*0.0 = 0.5
    assert v.composite == pytest.approx(0.5, abs=1e-6)
    assert v.unsupported_claims == ["claim X"]
    assert v.fabricated_citations == ["[bogus.md:1-2]"]


def test_dispatcher_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    cfg = BratanConfig()
    case = _make_case()
    retrieved = [_passage("fox.md", 3, 5)]

    seen_modes: list[str] = []

    def fake_anthropic(api_key, model, prompt):
        seen_modes.append("anthropic")
        return ('{"score": 1.0, "reason": "ok"}', 1, 1)

    def fake_vllm(base_url, model, prompt):
        seen_modes.append("vllm")
        return ('{"score": 1.0, "reason": "ok"}', 1, 1)

    with patch("pipeline.judge._call_anthropic", side_effect=fake_anthropic), patch(
        "pipeline.judge._call_vllm", side_effect=fake_vllm
    ):
        judge(case, "a", retrieved, cfg, mode="oracle")
        judge(case, "a", retrieved, cfg, mode="prejudge")

    assert seen_modes == ["anthropic", "anthropic", "vllm", "vllm"]


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


def test_weights_hash_stable_and_sensitive() -> None:
    h1 = _hash_weights(JudgeWeights())
    h2 = _hash_weights(JudgeWeights())
    h3 = _hash_weights(JudgeWeights(correctness=0.5, recall_at_5=0.3, faithfulness=0.2))
    assert h1 == h2
    assert h1 != h3
