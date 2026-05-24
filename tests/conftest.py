"""Top-level pytest fixtures.

Autouse-sandboxes the LLM disk cache so tests can't leak entries into
`<project_root>/.cache/llm/` or hit each other through shared state.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_llm_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the LLM cache at a tmp dir for every test, and reset hit/miss counters."""
    monkeypatch.setenv("BRATAN_LLM_CACHE_DIR", str(tmp_path / "_llm_cache"))
    from pipeline import cache as cache_mod

    cache_mod.reset_stats()
