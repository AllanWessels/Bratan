"""Tests for the ChromaAdapter's subprocess_query read-path mode.

When ``BRATAN_CHROMA_SUBPROCESS_QUERY=1`` (or ``subprocess_query=True`` is
passed to ``ChromaAdapter.__init__``), the adapter routes vector_query /
count / health_check through a fresh ``python -m scripts.query_worker``
subprocess. The mode also rejects writes/deletes outright — they must go
through ``scripts.ingest_worker`` instead — so the long-running uvicorn
process can never poison its own in-memory chromadb client.

These tests cover the contract directly. Every adapter instantiation
uses ``tmp_path / "chroma"`` so we never touch the real on-disk store.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from pipeline.adapters import chroma as chroma_mod
from pipeline.adapters.chroma import (
    _RECOVERABLE_MARKERS,
    _SUBPROCESS_QUERY_ENV,
    ChromaAdapter,
)


# ---------------------------------------------------------------------------
# Subprocess-mode happy paths
# ---------------------------------------------------------------------------


def test_subprocess_query_returns_empty_on_empty_collection(tmp_path: Path) -> None:
    """A fresh subprocess-mode adapter against an empty tmp .chroma must
    return [] from vector_query — NOT raise, NOT 500. This is the contract
    the FastAPI /api/corpus/search endpoint depends on."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="empty",
        subprocess_query=True,
    )

    hits = adapter.vector_query([1.0, 0.0, 0.0], k=5)
    assert hits == []


# ---------------------------------------------------------------------------
# Subprocess-mode write rejection
# ---------------------------------------------------------------------------


def test_subprocess_query_rejects_upsert(tmp_path: Path) -> None:
    """Writes against a subprocess-mode adapter must fail loudly. The whole
    point of the flag is that the long-running parent never touches
    chromadb's write API — that belongs to scripts.ingest_worker."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="rejects_writes",
        subprocess_query=True,
    )
    from pipeline.adapters.base import ChunkRecord

    chunk = ChunkRecord(
        id="x",
        text="anything",
        embedding=[1.0, 0.0],
        metadata={"path": "a.md", "start_line": 1, "end_line": 1},
    )

    with pytest.raises(RuntimeError) as excinfo:
        adapter.upsert([chunk])

    msg = str(excinfo.value)
    assert "subprocess_query" in msg
    assert "ingest_worker" in msg


def test_subprocess_query_rejects_delete(tmp_path: Path) -> None:
    """Same contract for delete() — writes belong to ingest_worker."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="rejects_deletes",
        subprocess_query=True,
    )

    with pytest.raises(RuntimeError) as excinfo:
        adapter.delete(["some-id"])

    msg = str(excinfo.value)
    assert "subprocess_query" in msg
    assert "ingest_worker" in msg


# ---------------------------------------------------------------------------
# Recoverable-marker classification (the structural piece that ensures the
# subprocess worker can return [] instead of bubbling a 500 to the parent)
# ---------------------------------------------------------------------------


def test_subprocess_query_recovers_from_missing_table() -> None:
    """The 'no such table: databases' marker (new variant observed in
    production) must be classified recoverable. The subprocess worker
    surfaces this string verbatim when chromadb's SQLite schema is
    half-migrated; the marker check is what lets the adapter swallow it
    and return [] instead of 500-ing.

    We don't need a live adapter to assert this — the classification is
    pure string membership against the module-level marker set.
    """
    err = (
        "Database error: error returned from database: (code: 1) "
        "no such table: databases"
    )
    assert any(marker in err for marker in _RECOVERABLE_MARKERS), (
        f"'no such table: databases' is the production marker that must be "
        f"recoverable; current marker set: {_RECOVERABLE_MARKERS}"
    )


def test_subprocess_query_returns_empty_after_recoverable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end variant: when the in-process query path raises a
    recoverable error and recovery leaves us against an empty collection,
    vector_query must return [] gracefully. Exercises the same swallow-on-
    empty branch the subprocess worker leans on inside its fresh process.
    """
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="recoverable",
        subprocess_query=False,  # need real in-process client to mock its query
    )

    state = {"called": 0}
    real_query = adapter._collection.query

    def boom_then_ok(**kwargs: Any) -> Any:
        state["called"] += 1
        if state["called"] == 1:
            raise Exception(
                "Database error: error returned from database: (code: 1) "
                "no such table: databases"
            )
        return real_query(**kwargs)

    monkeypatch.setattr(adapter._collection, "query", boom_then_ok)
    monkeypatch.setattr(adapter, "_recover", lambda: None)
    monkeypatch.setattr(adapter, "count", lambda: 0)

    assert adapter.vector_query([1.0, 0.0], k=3) == []


# ---------------------------------------------------------------------------
# Env-var toggle
# ---------------------------------------------------------------------------


def test_env_var_enables_subprocess_query(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Instantiating ChromaAdapter() with no explicit flag must inherit
    BRATAN_CHROMA_SUBPROCESS_QUERY=1 from the environment. This is how
    the uvicorn startup hook flips every adapter constructed during a
    request into subprocess mode."""
    monkeypatch.setenv(_SUBPROCESS_QUERY_ENV, "1")

    adapter = ChromaAdapter(path=tmp_path / "chroma", collection="env_test")

    assert adapter._subprocess_query is True
    # Crucially, we did NOT open a chromadb client (the whole point — the
    # parent process must not touch the path's Rust singleton).
    assert adapter._client is None
    assert adapter._collection is None


def test_env_var_falsy_values_keep_in_process_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Empty / 'false' / '0' must NOT flip subprocess mode on."""
    for falsy in ("", "0", "false", "no", "off"):
        monkeypatch.setenv(_SUBPROCESS_QUERY_ENV, falsy)
        adapter = ChromaAdapter(
            path=tmp_path / f"chroma-{falsy or 'empty'}",
            collection="env_falsy",
        )
        assert adapter._subprocess_query is False, (
            f"value {falsy!r} should not enable subprocess mode"
        )


def test_explicit_kwarg_overrides_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """subprocess_query=False explicit MUST win even when env says 1.
    The query_worker subprocess relies on this — it sets the kwarg
    explicitly so it never recurses into another subprocess call."""
    monkeypatch.setenv(_SUBPROCESS_QUERY_ENV, "1")

    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="override",
        subprocess_query=False,
    )

    assert adapter._subprocess_query is False
    # And the real in-process client IS connected.
    assert adapter._client is not None
    assert adapter._collection is not None


# ---------------------------------------------------------------------------
# Subprocess worker failure surfacing
# ---------------------------------------------------------------------------


def _make_completed(returncode: int, stdout: str = "", stderr: str = "") -> Any:
    """Mimic subprocess.CompletedProcess without needing the real fields."""

    class _CP:
        pass

    cp = _CP()
    cp.returncode = returncode
    cp.stdout = stdout
    cp.stderr = stderr
    return cp


def test_subprocess_worker_timeout_surfaces_clear_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A wedged worker (subprocess.TimeoutExpired) must surface as a
    RuntimeError naming the worker op and including the timeout — not a
    silent failure, not a generic 500."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="timeout_test",
        subprocess_query=True,
    )

    def fake_run(*args: Any, **kwargs: Any) -> Any:
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs.get("timeout", 60.0))

    monkeypatch.setattr(chroma_mod.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as excinfo:
        adapter.vector_query([1.0, 0.0], k=3)

    msg = str(excinfo.value)
    # The message must name the worker and op so debugging from logs is possible.
    assert "query worker" in msg.lower() or "worker" in msg.lower()
    assert "timed out" in msg
    assert "vector_query" in msg


def test_subprocess_worker_nonzero_exit_surfaces_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-zero exit with an empty stdout (worker crashed before writing JSON)
    must raise a RuntimeError that includes the exit code and stderr — the
    parent process and end user need to see WHY it died.
    """
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="crash_test",
        subprocess_query=True,
    )

    def fake_run(*args: Any, **kwargs: Any) -> Any:
        return _make_completed(
            returncode=1,
            stdout="",
            stderr="ImportError: No module named 'chromadb'",
        )

    monkeypatch.setattr(chroma_mod.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as excinfo:
        adapter.vector_query([1.0, 0.0], k=3)

    msg = str(excinfo.value)
    assert "query worker" in msg.lower() or "worker" in msg.lower()
    # exit code + stderr summary must surface, not a generic failure
    assert "ImportError" in msg or "chromadb" in msg


def test_subprocess_worker_failure_payload_surfaces_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the worker exits cleanly but returns {"ok": false, "error": ...},
    the adapter must raise a RuntimeError naming the op + the worker's error
    — not silently treat it as empty hits."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="bad_payload",
        subprocess_query=True,
    )

    def fake_run(*args: Any, **kwargs: Any) -> Any:
        payload = {"ok": False, "error": "worker tripped a sentinel"}
        return _make_completed(returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(chroma_mod.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as excinfo:
        adapter.vector_query([1.0, 0.0], k=3)

    msg = str(excinfo.value)
    assert "vector_query" in msg
    assert "worker tripped a sentinel" in msg


def test_subprocess_worker_garbage_stdout_surfaces_clear_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the worker emits non-JSON on stdout (eg. a stray print), the
    adapter must raise a RuntimeError flagging the bad output rather than
    crashing inside json.loads."""
    adapter = ChromaAdapter(
        path=tmp_path / "chroma",
        collection="bad_json",
        subprocess_query=True,
    )

    def fake_run(*args: Any, **kwargs: Any) -> Any:
        return _make_completed(returncode=0, stdout="not json at all", stderr="")

    monkeypatch.setattr(chroma_mod.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as excinfo:
        adapter.vector_query([1.0, 0.0], k=3)

    msg = str(excinfo.value)
    assert "non-JSON" in msg or "json" in msg.lower()
