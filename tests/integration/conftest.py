"""Shared fixtures for integration tests.

Goals:
- No GPU dependency — replace the BGE embedder with a deterministic hash-based stub.
- No real Anthropic calls — patch `pipeline.judge._call_anthropic` to return canned JSON.
- Hermetic project root in a tmp dir so reports / chroma / drafts don't leak.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

import pytest


# Deterministic 32-dim embedder — same text always maps to the same vector,
# different text maps to different vectors. Good enough for ranking assertions.
class StubEmbedder:
    DIM = 32

    def _vec(self, text: str) -> list[float]:
        h = hashlib.sha256(text.lower().encode("utf-8")).digest()
        # Map 32 hash bytes -> 32 floats in [-1, 1].
        return [(b / 255.0) * 2.0 - 1.0 for b in h[: self.DIM]]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@pytest.fixture
def tmp_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Tmp project root with corpus/ test_cases/ reports/ .chroma/ wired up."""
    root = tmp_path / "project"
    (root / "corpus").mkdir(parents=True)
    (root / "test_cases" / "generated").mkdir(parents=True)
    (root / "test_cases" / ".drafts").mkdir(parents=True)
    (root / "reports" / "history").mkdir(parents=True)
    (root / ".chroma").mkdir(parents=True)

    monkeypatch.setenv("BRATAN_PROJECT_ROOT", str(root))

    # Re-target module-level path constants that captured the real PROJECT_ROOT at import.
    from pipeline import metrics as metrics_mod
    from ui.backend import seed_store as seed_mod

    monkeypatch.setattr(metrics_mod, "PROJECT_ROOT", root, raising=True)
    monkeypatch.setattr(metrics_mod, "REPORTS_DIR", root / "reports", raising=True)
    monkeypatch.setattr(seed_mod, "_PROJECT_ROOT", root, raising=True)
    monkeypatch.setattr(seed_mod, "SEED_PATH", root / "test_cases" / "seed.jsonl", raising=True)
    monkeypatch.setattr(seed_mod, "DRAFTS_DIR", root / "test_cases" / ".drafts", raising=True)

    yield root


@pytest.fixture
def stub_embedder(monkeypatch: pytest.MonkeyPatch) -> StubEmbedder:
    """Replace `get_embedder` everywhere it's bound — module-top imports cache the name."""
    embedder = StubEmbedder()

    def factory(*_a, **_kw):
        return embedder

    from pipeline import embeddings, ingest

    # Patch the canonical source AND every consumer that imported it at module top.
    monkeypatch.setattr(embeddings, "get_embedder", factory)
    monkeypatch.setattr(ingest, "get_embedder", factory)
    # Reset the lazy singleton inside embeddings so any direct call routes through stubs.
    if hasattr(embeddings, "_EMBEDDER"):
        monkeypatch.setattr(embeddings, "_EMBEDDER", None, raising=False)
    return embedder


@pytest.fixture
def fake_anthropic(monkeypatch: pytest.MonkeyPatch):
    """Stub the Anthropic SDK call inside judge.py with a deterministic verdict.

    Returns the call log so tests can assert on what was sent.
    Adjustable behavior: monkeypatch the `verdict_for` callable.
    """
    calls: list[dict] = []

    def default_verdict_for(prompt: str) -> str:
        if "<ground_truth>" in prompt:
            return '{"score": 1.0, "reason": "stub_correctness", "low_confidence": false}'
        return (
            '{"score": 1.0, "unsupported_claims": [], "fabricated_citations": [], '
            '"reason": "stub_faithfulness", "low_confidence": false}'
        )

    state: dict[str, object] = {"verdict_for": default_verdict_for}

    def fake_call(api_key: str, model: str, prompt: str) -> tuple[str, int, int]:
        calls.append({"model": model, "prompt": prompt})
        verdict_for = state["verdict_for"]
        assert callable(verdict_for)
        text = verdict_for(prompt)
        return text, len(prompt), len(text)

    # Also stub the answer generator in pipeline.query so the API key check passes.
    def fake_generated_answer(api_key: str, model: str, prompt: str) -> str:
        return "Stub grounded answer based on retrieved passages."

    from pipeline import judge as judge_mod
    from pipeline import query as query_mod

    monkeypatch.setattr(judge_mod, "_call_anthropic", fake_call)
    monkeypatch.setattr(query_mod, "_call_anthropic", fake_generated_answer)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "stub-key-for-tests")

    return {"calls": calls, "state": state}
