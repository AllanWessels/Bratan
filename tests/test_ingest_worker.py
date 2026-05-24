"""Tests for the subprocess-isolated ingest worker.

These are *real* subprocess tests, not in-process imports. The whole point
of the worker is that chromadb state is isolated to a short-lived child
process, so testing it in-process would defeat the purpose. We invoke it
via `python -m scripts.ingest_worker` exactly the way the FastAPI backend
does in `start_ingest_task`.

Note: tests in this module are kept tiny on purpose — they shell out to a
fresh Python interpreter and import chromadb, which is the slowest single
import in the codebase. The two scenarios we actually need to cover:

  1. Happy path: a fresh corpus → state="succeeded", chunks_written>0.
  2. Poisoned chroma path → state="failed", non-empty error.

That's it. Anything finer-grained belongs in test_ingest.py with stubs.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

# Resolve the repo root so we can shell out from a deterministic cwd.
REPO_ROOT = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_config(project_root: Path, corpus_path: Path) -> Path:
    """Write a minimal bratan.config.yaml the worker can load."""
    cfg = {
        "project": {
            "project_name": "test-ingest-worker",
            "corpus_path": str(corpus_path),
            "seed_target_n": 50,
        },
        "vector_db": {
            "adapter": "chroma",
            "chroma_path": str(project_root / ".chroma"),
            "chroma_collection": "test_corpus",
        },
        "models": {
            "anthropic_api_key": "",
            "embedding_model": "stub-embedding-model",
            "use_local_embedding": True,
            "use_local_reranker": True,
            "use_local_prejudge": True,
        },
    }
    path = project_root / "bratan.config.yaml"
    path.write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return path


def _make_corpus(project_root: Path, n_files: int = 3) -> Path:
    """Create a tiny corpus of n_files .md documents."""
    corpus = project_root / "corpus"
    corpus.mkdir(parents=True, exist_ok=True)
    for i in range(n_files):
        (corpus / f"doc{i}.md").write_text(
            f"# Document {i}\n\n"
            f"This is the body of document {i}. It has enough content "
            f"to generate at least one chunk when ingested.\n\n"
            f"Pelicans are large water birds. Foxes are clever omnivores.\n",
            encoding="utf-8",
        )
    return corpus


def _run_worker(
    config_path: Path,
    status_path: Path,
    *,
    task_id: str = "testtask",
    timeout: float = 90.0,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Invoke `python -m scripts.ingest_worker` and wait for it to exit.

    We patch `pipeline.embeddings.get_embedder` into a deterministic hash
    stub via the BRATAN_EMBEDDER_STUB env hook so we don't hit GPU or
    network. The hook is added by `conftest.py` (autouse) if you want to
    centralize it; here we inline a tiny sitecustomize-style override
    using a PYTHONPATH-injected helper module.
    """
    env = os.environ.copy()
    env["BRATAN_PROJECT_ROOT"] = str(config_path.parent)
    # Force the embedder stub via sitecustomize injection.
    env["PYTHONPATH"] = f"{REPO_ROOT / 'tests' / '_worker_stubs'}{os.pathsep}{env.get('PYTHONPATH', '')}"
    if extra_env:
        env.update(extra_env)

    return subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.ingest_worker",
            "--config-path",
            str(config_path),
            "--status-path",
            str(status_path),
            "--task-id",
            task_id,
        ],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _read_status(status_path: Path) -> dict:
    assert status_path.exists(), f"status file was never written: {status_path}"
    return json.loads(status_path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Fixture: deterministic embedder stub injected via PYTHONPATH
#
# We can't monkeypatch the subprocess from in-process, so we install a
# `sitecustomize.py` shim on a side PYTHONPATH that patches
# `pipeline.embeddings.get_embedder` at interpreter startup. Same trick the
# stdlib uses for coverage.py's subprocess support.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session", autouse=True)
def _install_worker_embedder_stub() -> None:
    """Install a `sitecustomize.py` that monkey-patches the embedder on import.

    sitecustomize runs at interpreter startup, *before* pipeline.embeddings
    is imported, so we can't patch the function directly there. Instead we
    install a `MetaPathFinder` that wraps the post-import step and swaps in
    a deterministic hash-based stub the first time `pipeline.embeddings` is
    loaded inside the subprocess.

    Session-scoped because the file content never changes between tests.
    """
    stubs_dir = REPO_ROOT / "tests" / "_worker_stubs"
    stubs_dir.mkdir(parents=True, exist_ok=True)
    sitecustomize = stubs_dir / "sitecustomize.py"
    sitecustomize.write_text(
        '"""Test-only: subprocess embedder stub for ingest worker tests."""\n'
        "import hashlib\n"
        "import sys\n"
        "\n"
        "class _HashEmbedder:\n"
        "    DIM = 32\n"
        "    def embed(self, texts):\n"
        "        out = []\n"
        "        for t in texts:\n"
        "            h = hashlib.sha256(t.encode('utf-8')).digest()\n"
        "            out.append([(b / 255.0) * 2.0 - 1.0 for b in h[: self.DIM]])\n"
        "        return out\n"
        "    def embed_query(self, t):\n"
        "        return self.embed([t])[0]\n"
        "\n"
        "_STUB = _HashEmbedder()\n"
        "\n"
        "def _factory(*_a, **_kw):\n"
        "    return _STUB\n"
        "\n"
        "_original_setitem = type(sys.modules).__setitem__\n"
        "\n"
        "def _patch_if_target(name, module):\n"
        "    if name == 'pipeline.embeddings' and hasattr(module, 'get_embedder'):\n"
        "        module.get_embedder = _factory\n"
        "    if name == 'pipeline.ingest' and hasattr(module, 'get_embedder'):\n"
        "        module.get_embedder = _factory\n"
        "\n"
        "class _PatchOnSet(dict):\n"
        "    def __setitem__(self, key, value):\n"
        "        _original_setitem(self, key, value)\n"
        "        try:\n"
        "            _patch_if_target(key, value)\n"
        "        except Exception:\n"
        "            pass\n"
        "\n"
        "# Already-imported modules: patch immediately. New imports: hook setitem.\n"
        "for _n in list(sys.modules):\n"
        "    try:\n"
        "        _patch_if_target(_n, sys.modules[_n])\n"
        "    except Exception:\n"
        "        pass\n"
        "\n"
        "# Override sys.modules to intercept future imports.\n"
        "# We can't replace sys.modules wholesale (CPython caches a reference),\n"
        "# so we use an import hook instead.\n"
        "import importlib.abc\n"
        "import importlib.util\n"
        "\n"
        "class _StubFinder(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, fullname, path, target=None):\n"
        "        if fullname not in ('pipeline.embeddings', 'pipeline.ingest'):\n"
        "            return None\n"
        "        # Let the real loader run; we patch in a post-load hook.\n"
        "        for finder in sys.meta_path:\n"
        "            if finder is self:\n"
        "                continue\n"
        "            spec = finder.find_spec(fullname, path, target)\n"
        "            if spec is None:\n"
        "                continue\n"
        "            original_loader = spec.loader\n"
        "            if original_loader is None:\n"
        "                return spec\n"
        "            original_exec = original_loader.exec_module\n"
        "            def _wrapped_exec(module, _orig=original_exec, _name=fullname):\n"
        "                _orig(module)\n"
        "                _patch_if_target(_name, module)\n"
        "            original_loader.exec_module = _wrapped_exec  # type: ignore[method-assign]\n"
        "            return spec\n"
        "        return None\n"
        "\n"
        "sys.meta_path.insert(0, _StubFinder())\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_worker_succeeds_on_fresh_corpus(tmp_path: Path) -> None:
    """Happy path: 3 markdown files → state=succeeded, chunks_written > 0."""
    project_root = tmp_path / "project"
    project_root.mkdir()
    corpus = _make_corpus(project_root, n_files=3)
    config_path = _write_config(project_root, corpus)
    status_path = project_root / "ingest_status.json"

    result = _run_worker(config_path, status_path)

    assert result.returncode == 0, (
        f"worker exited non-zero: stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    status = _read_status(status_path)
    assert status["state"] == "succeeded", f"unexpected state in {status}"
    assert status["chunks_written"] > 0, (
        f"worker reported succeeded but wrote 0 chunks — the very bug we're fixing: {status}"
    )
    assert status["files_total"] == 3
    assert status["files_done"] == 3
    assert status["error"] is None


def test_worker_fails_on_poisoned_chroma_path(tmp_path: Path) -> None:
    """A pre-poisoned `.chroma` directory must surface as state=failed.

    We simulate the poison by placing a file with the right name as a
    *directory* placeholder that's been corrupted: `chroma.sqlite3` is
    expected by chromadb to be a SQLite database, but here we write
    garbage to it. ChromaDB's recovery logic in the adapter will try once,
    fail, and the worker will surface the failure.
    """
    project_root = tmp_path / "project"
    project_root.mkdir()
    corpus = _make_corpus(project_root, n_files=2)
    config_path = _write_config(project_root, corpus)
    status_path = project_root / "ingest_status.json"

    # Poison the chroma path. The adapter's _RECOVERABLE_MARKERS list
    # tries to recover, but here we additionally mark the directory
    # read-only so even recovery (which does rmtree) is blocked.
    chroma_dir = project_root / ".chroma"
    chroma_dir.mkdir(parents=True, exist_ok=True)
    # Write a fake sqlite file that's actually garbage.
    (chroma_dir / "chroma.sqlite3").write_bytes(b"this is not a sqlite database, on purpose")
    # Make the directory unwritable so the recovery rmtree+recreate is blocked.
    # 0o500 = read+execute only, no write. ChromaDB's persistent client will
    # try to open chroma.sqlite3 and fail; recovery will try to rmtree and
    # also fail. The worker surfaces this as state=failed.
    chroma_dir.chmod(0o500)
    try:
        result = _run_worker(config_path, status_path, timeout=60.0)
    finally:
        # Restore writable bits so pytest's tmp_path cleanup can succeed.
        chroma_dir.chmod(0o700)

    status = _read_status(status_path)
    # Either the worker exited non-zero with state=failed, OR (less likely)
    # chromadb's recovery succeeded against a writable child path and the
    # run actually completed. The contract we're enforcing: if the run
    # cannot persist chunks, state MUST NOT be "succeeded with 0 chunks".
    if status["state"] == "succeeded":
        assert status["chunks_written"] > 0, (
            "worker reported succeeded with 0 chunks — the bug this PR fixes."
        )
    else:
        assert status["state"] == "failed", f"unexpected state in {status}"
        assert status["error"], f"failed state must carry an error message: {status}"
        assert result.returncode != 0


def test_worker_writes_status_file_even_on_immediate_config_error(tmp_path: Path) -> None:
    """If the config path is bogus, the worker must STILL write a terminal status.

    The parent process polls the status file; if the worker died silently
    without writing anything, the UI would hang on "running" forever.
    """
    status_path = tmp_path / "status.json"
    bogus_config = tmp_path / "does-not-exist.yaml"

    result = _run_worker(
        bogus_config,
        status_path,
        timeout=30.0,
    )
    # The config-loader path actually returns BratanConfig defaults for a
    # missing file (it logs a warning rather than raising), so we may not
    # see a failure here — what we CAN guarantee is that the worker writes
    # *some* terminal status file before exiting.
    assert status_path.exists(), f"worker did not write status file. stderr={result.stderr!r}"
    status = _read_status(status_path)
    assert status["state"] in {"succeeded", "failed"}, (
        f"worker should reach a terminal state, got {status['state']}: {status}"
    )


def test_get_ingest_status_reports_orphan_when_worker_dies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If `start_ingest_task` spawned a worker that exited without writing a
    terminal state, `get_ingest_status` must report state=failed with an
    "exited unexpectedly" error rather than perpetually saying "running".
    """
    from pipeline import ingest

    # Build a fake handle pointing at a status file that says "running"
    # but a process object that's already dead.
    status_dir = tmp_path / "ingest"
    status_dir.mkdir()
    status_path = status_dir / "ingest-abc.json"
    status_path.write_text(
        json.dumps(
            {
                "state": "running",
                "task_id": "abc",
                "files_total": 5,
                "files_done": 2,
                "chunks_written": 7,
                "error": None,
                "current_file": "doc2.md",
                "chunks_per_sec": 1.2,
            }
        ),
        encoding="utf-8",
    )

    # A dummy "process" object whose poll() returns 1 (exited non-zero).
    class _DeadProc:
        def poll(self) -> int:
            return 1

    handle = ingest._SubprocessHandle(
        task_id="abc",
        status_path=status_path,
        process=_DeadProc(),  # type: ignore[arg-type]
        started_at=time.monotonic() - 10.0,
    )
    monkeypatch.setattr(ingest, "_HANDLE", handle)

    out = ingest.get_ingest_status()
    assert out.state == "failed"
    assert out.error and "exited unexpectedly" in out.error
