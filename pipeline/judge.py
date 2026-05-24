"""Judge router: deterministic recall + two LLM rubrics (correctness, faithfulness).

The router exposes `prejudge()` and `oracle_judge()` as separate named functions plus
a `judge(..., mode)` dispatcher. The caller picks; this is *not* a hidden swap.

- `prejudge()`  → calls the local prejudge model (Qwen) via vLLM. Cheap, frequent, fine
                  for inner-loop iterations and subset sweeps. NEVER used to write a
                  report to `/reports/` or to accept/revert a blue-team change.
- `oracle_judge()` → calls Sonnet 4. Used for every consequential decision: full evals
                  written to `/reports/`, accept/revert, regression scoring, drift
                  checks. This is the load-bearing invariant from CLAUDE.md.

Both produce a `JudgeVerdict` with the same schema; only the model and the
`judge_mode` field differ.

Composite formula: `correctness*w_c + recall@5*w_r + faithfulness*w_f` with weights
read from `cfg.judge_weights` (defaults 0.4 / 0.3 / 0.3 per CLAUDE.md).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from pipeline import cache as _cache
from ui.backend.schemas import BratanConfig, JudgeWeights, Passage, PassageRef, SeedCase

logger = logging.getLogger(__name__)

_PROMPTS_DIR = Path(__file__).resolve().parents[1] / "agents" / "judge" / "prompts"
CORRECTNESS_PROMPT_PATH = _PROMPTS_DIR / "correctness.md"
FAITHFULNESS_PROMPT_PATH = _PROMPTS_DIR / "faithfulness.md"

JudgeMode = Literal["prejudge", "oracle"]

_JSON_OBJECT_RE = re.compile(r"\{(?:[^{}]|(?:\{[^{}]*\}))*\}", re.DOTALL)


# ---------------------------------------------------------------------------
# Verdict shape
# ---------------------------------------------------------------------------


class JudgeVerdict(BaseModel):
    """Per-case grading output. Written into `/reports/run-<ts>.json::by_case[]`."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    composite: float
    retrieval_recall_at_5: float
    answer_correctness: float | None
    faithfulness: float | None
    correctness_reason: str = ""
    faithfulness_reason: str = ""
    unsupported_claims: list[str] = Field(default_factory=list)
    fabricated_citations: list[str] = Field(default_factory=list)
    low_confidence_reasons: list[str] = Field(default_factory=list)
    judge_mode: JudgeMode
    model_used: str
    judge_weights_hash: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: float = 0.0


# ---------------------------------------------------------------------------
# Deterministic: retrieval recall @ 5
# ---------------------------------------------------------------------------


def recall_at_5(case: SeedCase, retrieved: list[Passage]) -> float:
    """Fraction of the case's source_passages that overlap any top-5 retrieved chunk.

    Returns 1.0 when the case has no source_passages (out_of_scope cases that
    expect a refusal — the retrieval target is "nothing relevant").
    """
    if not case.source_passages:
        return 1.0
    top5 = retrieved[:5]
    matches = 0
    for sp in case.source_passages:
        if any(_passage_overlaps(sp, r) for r in top5):
            matches += 1
    return matches / len(case.source_passages)


def _passage_overlaps(ref: PassageRef, hit: Passage) -> bool:
    if hit.path != ref.path:
        return False
    return not (hit.line_end < ref.line_start or hit.line_start > ref.line_end)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def prejudge(
    case: SeedCase,
    generated_answer: str | None,
    retrieved: list[Passage],
    cfg: BratanConfig,
) -> JudgeVerdict:
    """Cheap local-model verdict for inner-loop iterations. Not for reports."""
    return _do_judge(case, generated_answer, retrieved, cfg, mode="prejudge")


def oracle_judge(
    case: SeedCase,
    generated_answer: str | None,
    retrieved: list[Passage],
    cfg: BratanConfig,
) -> JudgeVerdict:
    """Sonnet 4 verdict used for every consequential decision."""
    return _do_judge(case, generated_answer, retrieved, cfg, mode="oracle")


def judge(
    case: SeedCase,
    generated_answer: str | None,
    retrieved: list[Passage],
    cfg: BratanConfig,
    mode: JudgeMode,
) -> JudgeVerdict:
    return _do_judge(case, generated_answer, retrieved, cfg, mode=mode)


# ---------------------------------------------------------------------------
# Drift check (M3 reliability control)
# ---------------------------------------------------------------------------


def drift_check(cfg: BratanConfig, n_samples: int = 5) -> "DriftBlock":  # noqa: F821, UP037
    """Re-grade a random sample of historical oracle verdicts and report disagreement.

    Walks `reports/history/`, samples `n_samples` `(case_id, prior_composite)` rows
    from cases that were graded by the oracle, reconstructs each by re-running
    `pipeline.query.answer()` and `oracle_judge()`, and counts disagreements
    where `abs(prior - new) > 0.1`.

    Both ends of the re-evaluation hit the LLM disk cache, so a stable pipeline
    pays near-zero cost across drift checks. Returns `DriftBlock(0, 0.0)` if
    `n_samples <= 0` or there's no history to sample from.
    """
    # Imported lazily so this module can be imported without pulling the whole graph.
    import random

    from pipeline.metrics import REPORTS_DIR, DriftBlock
    from pipeline.query import answer as _pipeline_answer
    from ui.backend.seed_store import _read_all_cases

    if n_samples <= 0:
        return DriftBlock()

    history_dir = REPORTS_DIR / "history"
    if not history_dir.exists():
        return DriftBlock()

    pool: list[tuple[str, float]] = []  # (case_id, prior_composite)
    for report_path in sorted(history_dir.glob("run-*.json")):
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("drift_check: skipping unreadable %s: %s", report_path.name, exc)
            continue
        for row in payload.get("by_case", []) or []:
            if row.get("judge_mode") != "oracle":
                continue
            cid = row.get("case_id")
            comp = row.get("composite")
            if isinstance(cid, str) and isinstance(comp, (int, float)):
                pool.append((cid, float(comp)))

    if not pool:
        return DriftBlock()

    rng = random.Random(0xB47A4)
    sample = rng.sample(pool, k=min(n_samples, len(pool)))

    cases_by_id = {c.id: c for c in _read_all_cases()}

    checked = 0
    disagreements = 0
    for case_id, prior_composite in sample:
        case = cases_by_id.get(case_id)
        if case is None:
            logger.info("drift_check: case %s no longer in seed.jsonl — skipping", case_id)
            continue
        try:
            result = _pipeline_answer(cfg, case.question)
            retrieved = result.get("retrieved") or []
            new_verdict = oracle_judge(case, result.get("answer"), retrieved, cfg)
        except Exception as exc:
            logger.warning("drift_check: re-eval of %s failed: %s", case_id, exc)
            continue

        if new_verdict.answer_correctness is None or new_verdict.faithfulness is None:
            # Judge couldn't grade (likely no API key); skip rather than miscount.
            continue

        checked += 1
        if abs(new_verdict.composite - prior_composite) > 0.1:
            disagreements += 1

    rate = (disagreements / checked) if checked > 0 else 0.0
    return DriftBlock(samples_checked=checked, disagreement_rate=rate)


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


def _do_judge(
    case: SeedCase,
    generated_answer: str | None,
    retrieved: list[Passage],
    cfg: BratanConfig,
    mode: JudgeMode,
) -> JudgeVerdict:
    t0 = time.perf_counter()
    weights = cfg.judge_weights
    weights_hash = _hash_weights(weights)

    rec = recall_at_5(case, retrieved)

    caller, model, no_llm_reason = _select_caller(cfg, mode)
    if caller is None:
        return _make_verdict(
            case=case,
            mode=mode,
            model="",
            rec=rec,
            c_score=None,
            f_score=None,
            c_reason="",
            f_reason="",
            unsup=[],
            fab=[],
            low_conf=[no_llm_reason] if no_llm_reason else [],
            weights=weights,
            weights_hash=weights_hash,
            tokens_in=0,
            tokens_out=0,
            t0=t0,
        )

    answer_text = generated_answer or ""

    correctness_prompt = _render_prompt(
        CORRECTNESS_PROMPT_PATH,
        question=case.question,
        ground_truth=case.ground_truth,
        generated_answer=answer_text,
    )
    faithfulness_prompt = _render_prompt(
        FAITHFULNESS_PROMPT_PATH,
        question=case.question,
        retrieved_passages=_format_passages_block(retrieved),
        generated_answer=answer_text,
    )

    low_conf: list[str] = []
    tokens_in = tokens_out = 0

    c_score, c_reason, c_extra, c_ti, c_to = _grade(caller, correctness_prompt, "correctness")
    tokens_in += c_ti
    tokens_out += c_to
    low_conf.extend(c_extra)

    f_score, f_reason, f_extra, f_ti, f_to = _grade(caller, faithfulness_prompt, "faithfulness")
    tokens_in += f_ti
    tokens_out += f_to
    low_conf.extend(f_extra)

    # extract structured faithfulness fields if present in the last parsed payload
    last_raw_faith = _LAST_PARSED.get("faithfulness", {}) or {}
    unsup = [str(x) for x in (last_raw_faith.get("unsupported_claims") or [])]
    fab = [str(x) for x in (last_raw_faith.get("fabricated_citations") or [])]

    return _make_verdict(
        case=case,
        mode=mode,
        model=model,
        rec=rec,
        c_score=c_score,
        f_score=f_score,
        c_reason=c_reason,
        f_reason=f_reason,
        unsup=unsup,
        fab=fab,
        low_conf=low_conf,
        weights=weights,
        weights_hash=weights_hash,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        t0=t0,
    )


def _make_verdict(
    *,
    case: SeedCase,
    mode: JudgeMode,
    model: str,
    rec: float,
    c_score: float | None,
    f_score: float | None,
    c_reason: str,
    f_reason: str,
    unsup: list[str],
    fab: list[str],
    low_conf: list[str],
    weights: JudgeWeights,
    weights_hash: str,
    tokens_in: int,
    tokens_out: int,
    t0: float,
) -> JudgeVerdict:
    composite = (
        weights.correctness * (c_score if c_score is not None else 0.0)
        + weights.recall_at_5 * rec
        + weights.faithfulness * (f_score if f_score is not None else 0.0)
    )
    return JudgeVerdict(
        case_id=case.id,
        composite=composite,
        retrieval_recall_at_5=rec,
        answer_correctness=c_score,
        faithfulness=f_score,
        correctness_reason=c_reason,
        faithfulness_reason=f_reason,
        unsupported_claims=unsup,
        fabricated_citations=fab,
        low_confidence_reasons=low_conf,
        judge_mode=mode,
        model_used=model,
        judge_weights_hash=weights_hash,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=(time.perf_counter() - t0) * 1000.0,
    )


# ---------------------------------------------------------------------------
# Grading helper
# ---------------------------------------------------------------------------


# Stash last-parsed JSON for each rubric so structured fields (unsupported_claims,
# fabricated_citations) can be lifted into the verdict without a second pass.
_LAST_PARSED: dict[str, dict[str, Any]] = {}


def _grade(
    caller, prompt: str, rubric: str
) -> tuple[float | None, str, list[str], int, int]:
    try:
        raw, ti, to = caller(prompt)
    except Exception as exc:
        logger.warning("%s LLM call failed: %s", rubric, exc)
        _LAST_PARSED[rubric] = {}
        return None, f"{rubric}_call_error: {exc}", [f"{rubric}_call_error"], 0, 0

    parsed = _parse_score_json(raw)
    _LAST_PARSED[rubric] = parsed

    if not parsed:
        return None, f"{rubric}_parse_error", [f"{rubric}_parse_error"], ti, to

    score = parsed.get("score")
    reason = str(parsed.get("reason", ""))
    low_conf_flag = bool(parsed.get("low_confidence", False))
    extra: list[str] = []
    if low_conf_flag:
        extra.append(f"{rubric}:low_confidence ({reason})")
    if score is None or not isinstance(score, (int, float)) or score not in (0.0, 0.5, 1.0):
        extra.append(f"{rubric}_invalid_score:{score!r}")
        return None, reason or f"{rubric}_invalid_score", extra, ti, to
    return float(score), reason, extra, ti, to


# ---------------------------------------------------------------------------
# LLM callers
# ---------------------------------------------------------------------------


def _select_caller(
    cfg: BratanConfig, mode: JudgeMode
) -> tuple[Any | None, str, str | None]:
    """Return `(caller(prompt) -> (text, tokens_in, tokens_out), model, no_llm_reason)`.

    The returned caller is wrapped through `pipeline.cache.cached_call` when
    `cfg.cost.cache_ttl_hours > 0` — judge calls at temperature 0 are stable,
    so memoizing them is safe. The wrapper records hit/miss into
    `pipeline.cache.CACHE_STATS`; callers read it after the run.
    """
    ttl = float(getattr(cfg.cost, "cache_ttl_hours", 0) or 0)
    if mode == "oracle":
        api_key = cfg.models.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        model = cfg.models.oracle_model
        if not api_key:
            return None, model, "no_anthropic_api_key"

        def caller(prompt: str) -> tuple[str, int, int]:
            if ttl > 0:
                text, ti, to, _hit = _cache.cached_call(
                    _call_anthropic, model, prompt, 0.0, ttl, api_key, model, prompt
                )
                return text, ti, to
            return _call_anthropic(api_key, model, prompt)

        return caller, model, None

    base_url = (cfg.models.vllm_base_url or "").rstrip("/")
    model = cfg.models.prejudge_model
    if not base_url:
        return None, model, "no_vllm_base_url"

    def caller(prompt: str) -> tuple[str, int, int]:
        if ttl > 0:
            text, ti, to, _hit = _cache.cached_call(
                _call_vllm, model, prompt, 0.0, ttl, base_url, model, prompt
            )
            return text, ti, to
        return _call_vllm(base_url, model, prompt)

    return caller, model, None


def _call_anthropic(api_key: str, model: str, prompt: str) -> tuple[str, int, int]:
    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=512,
        temperature=0.0,
        messages=[{"role": "user", "content": prompt}],
    )
    parts: list[str] = []
    for block in resp.content:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    text = "".join(parts).strip()
    usage = getattr(resp, "usage", None)
    tokens_in = int(getattr(usage, "input_tokens", 0) or 0)
    tokens_out = int(getattr(usage, "output_tokens", 0) or 0)
    return text, tokens_in, tokens_out


def _call_vllm(base_url: str, model: str, prompt: str) -> tuple[str, int, int]:
    """vLLM's OpenAI-compatible chat completions endpoint."""
    url = f"{base_url}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.0,
        "max_tokens": 512,
    }
    with httpx.Client(timeout=60.0) as client:
        r = client.post(url, json=payload)
        r.raise_for_status()
        body = r.json()
    text = body["choices"][0]["message"]["content"].strip()
    usage = body.get("usage", {}) or {}
    tokens_in = int(usage.get("prompt_tokens", 0) or 0)
    tokens_out = int(usage.get("completion_tokens", 0) or 0)
    return text, tokens_in, tokens_out


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------


def _render_prompt(path: Path, **kwargs: str) -> str:
    template = path.read_text(encoding="utf-8")
    for key, value in kwargs.items():
        template = template.replace("{{" + key + "}}", value)
    return template


def _format_passages_block(passages: list[Passage]) -> str:
    if not passages:
        return "(no passages retrieved)"
    return "\n\n".join(
        f"[{p.path}:{p.line_start}-{p.line_end}] {p.content}" for p in passages
    )


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------


def _parse_score_json(raw: str) -> dict[str, Any]:
    """Find and parse the JSON object in an LLM response, tolerating surrounding prose."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        pass
    for match in _JSON_OBJECT_RE.finditer(raw):
        chunk = match.group(0)
        try:
            return json.loads(chunk)
        except Exception:
            continue
    return {}


def _hash_weights(weights: JudgeWeights) -> str:
    payload = json.dumps(
        {
            "correctness": weights.correctness,
            "recall_at_5": weights.recall_at_5,
            "faithfulness": weights.faithfulness,
        },
        sort_keys=True,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]
