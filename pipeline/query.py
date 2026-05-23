"""Naive M1 pipeline skeleton.

Just enough surface for `seed_store.validate(...run_pipeline=True)` and the corpus
search endpoint to work. M2's blue team replaces the body of this module with
something serious; the public function signatures here are the contract M2 must keep.
"""

from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from pipeline.adapters.base import QueryHit
from ui.backend.schemas import BratanConfig, CorpusSearchResponse, Passage

logger = logging.getLogger(__name__)

_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "generation.md"
_FALLBACK_MODEL = "claude-sonnet-4-20250514"


def search_corpus(cfg: BratanConfig, query_text: str, k: int = 10) -> CorpusSearchResponse:
    """Naive vector-only top-k search against the configured adapter."""
    from pipeline.embeddings import get_embedder
    from pipeline.factories import get_vectordb

    t0 = time.perf_counter()
    embedder = get_embedder(cfg.models.embedding_model)
    q_vec = embedder.embed_query(query_text)
    adapter = get_vectordb(cfg)
    hits = adapter.vector_query(q_vec, k)
    passages = [_hit_to_passage(h) for h in hits]
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return CorpusSearchResponse(
        passages=passages,
        embedding_model=cfg.models.embedding_model,
        latency_ms=latency_ms,
    )


def answer(cfg: BratanConfig, question: str, k: int = 5) -> dict:
    """Retrieve top-k passages and ask the oracle LLM for a grounded answer."""
    t0 = time.perf_counter()
    retrieval = search_corpus(cfg, question, k)
    passages = retrieval.passages

    api_key = cfg.models.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        latency_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "answer": None,
            "retrieved": passages,
            "latency_ms": latency_ms,
            "model": None,
            "warning": "no_api_key",
        }

    model = cfg.models.oracle_model or _FALLBACK_MODEL
    prompt = _render_prompt(question, passages)
    answer_text = _call_anthropic(api_key, model, prompt)
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "answer": answer_text,
        "retrieved": passages,
        "latency_ms": latency_ms,
        "model": model,
    }


def naive_pipeline_score(ground_truth: str, generated_answer: str) -> float:
    """1.0 iff `ground_truth` is a normalized substring of `generated_answer`."""
    if not ground_truth or not generated_answer:
        return 0.0
    gt = _normalize(ground_truth)
    ans = _normalize(generated_answer)
    if not gt:
        return 0.0
    return 1.0 if gt in ans else 0.0


def _hit_to_passage(hit: QueryHit) -> Passage:
    meta = hit.metadata or {}
    path = str(meta.get("path", meta.get("source", "")))
    line_start = int(meta.get("start_line", 1) or 1)
    line_end = int(meta.get("end_line", line_start) or line_start)
    return Passage(
        path=path,
        line_start=line_start,
        line_end=line_end,
        content=hit.text,
        score=hit.score,
    )


def _render_prompt(question: str, passages: list[Passage]) -> str:
    template = _PROMPT_PATH.read_text(encoding="utf-8")
    if passages:
        block = "\n\n".join(
            f"[{p.path}:{p.line_start}-{p.line_end}] {p.content}" for p in passages
        )
    else:
        block = "(no passages retrieved)"
    return template.replace("{{passages_block}}", block).replace("{{question}}", question)


def _call_anthropic(api_key: str, model: str, prompt: str) -> str:
    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=1024,
        temperature=0.0,
        messages=[{"role": "user", "content": prompt}],
    )
    parts: list[str] = []
    for block in resp.content:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "".join(parts).strip()


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()
