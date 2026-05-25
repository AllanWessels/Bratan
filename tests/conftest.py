"""Top-level pytest fixtures.

Two autouse safety nets that every test inherits:

1. ``_isolate_llm_cache`` — redirects the LLM disk cache to a tmp dir so tests
   can't leak entries into ``<project_root>/.cache/llm/``.
2. ``_refuse_real_chroma_writes`` — snapshots ``<project_root>/.chroma`` at
   test start and fails the test loudly if it changed (or appeared) at test
   end. This is a regression guard for a bug where tests writing 32-dim
   StubEmbedder vectors into the real on-disk store caused subsequent live
   ``/api/corpus/search`` calls (which use 384-dim BGE-small) to 500 with
   ``Collection expecting embedding with dimension of 32``.

Both are belt-and-braces: ``pipeline.adapters.chroma`` also refuses to open
the project-default path when ``PYTEST_CURRENT_TEST`` is set. If THAT guard
fires first, the test fails before any state corruption occurs; if a test
somehow slips past it (e.g. by bypassing the adapter), the mtime snapshot
catches the damage after the fact.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# Resolve the real project root from this file's location. conftest.py lives
# at <repo>/tests/conftest.py, so parents[1] is the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_PROJECT_CHROMA_DIR = _REPO_ROOT / ".chroma"
_PROJECT_CHROMA_SQLITE = _PROJECT_CHROMA_DIR / "chroma.sqlite3"


@pytest.fixture(autouse=True)
def _isolate_llm_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the LLM cache at a tmp dir for every test, and reset hit/miss counters."""
    monkeypatch.setenv("BRATAN_LLM_CACHE_DIR", str(tmp_path / "_llm_cache"))
    from pipeline import cache as cache_mod

    cache_mod.reset_stats()


def _chroma_fingerprint() -> tuple[bool, float, int]:
    """Cheap snapshot of the project-root .chroma store.

    Returns (sqlite_exists, sqlite_mtime, sqlite_size). Tests that touch the
    real store will move at least one of those. We deliberately don't hash
    the file contents — that's expensive and the mtime+size triple is
    sufficient to detect any write.
    """
    if not _PROJECT_CHROMA_SQLITE.exists():
        return (False, 0.0, 0)
    st = _PROJECT_CHROMA_SQLITE.stat()
    return (True, st.st_mtime, st.st_size)


@pytest.fixture(autouse=True)
def _refuse_real_chroma_writes() -> None:
    """Fail loudly if a test wrote to <project_root>/.chroma/chroma.sqlite3.

    Snapshots the file's existence, mtime, and size at test start; compares
    at test end. Any divergence means a test poisoned the real on-disk store
    with whatever embedder/vectors it was using — almost always the 32-dim
    StubEmbedder, which then breaks the live UI on the next BGE-small call.

    This is autouse so every test inherits the check at zero call-site cost.
    """
    before = _chroma_fingerprint()
    yield
    after = _chroma_fingerprint()
    if before == after:
        return
    # Build a diagnostic that names the offending test so we can fix it.
    import os

    offender = os.environ.get("PYTEST_CURRENT_TEST", "<unknown test>")
    raise AssertionError(
        "A pytest test mutated the real project-root .chroma store. "
        f"This poisons the live UI's vector DB (32-dim stub vs 384-dim "
        f"production embedder). Before={before} After={after}. "
        f"Test: {offender}. The test must pass an explicit tmp_path-based "
        f"chroma_path; see tests/integration/conftest.py::tmp_project for "
        f"the canonical pattern."
    )
