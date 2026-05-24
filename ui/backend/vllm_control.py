"""vLLM lifecycle — start / stop / status for a managed `vllm serve` subprocess.

Mirrors the shape of `loop_control.py`: a single module-level singleton owns the
subprocess handle, callers go through `start()`, `stop()`, `status()`. Only one
managed vLLM can run at a time per backend process.

State machine: stopped -> starting -> (downloading) -> ready | failed
- "stopped": no process (default).
- "starting": Popen succeeded, awaiting `/v1/models` 200.
- "downloading": detected the "downloading"/"fetching" line in the log.
- "ready": `/v1/models` returned successfully.
- "failed": process exited before ready, OR an exception bubbled from spawn.

We poll `/v1/models` in a background thread so the HTTP layer stays responsive;
the thread also tails the log to detect a download phase and surface progress.

The subprocess is grouped with uvicorn (no `start_new_session=True`) so closing
the browser keeps it alive, but `kill uvicorn` will reap the whole tree.

If the `vllm` CLI is not on PATH (the `[gpu]` extra was never synced), `start()`
raises `VLLMNotInstalledError` and the route layer returns 422.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

logger = logging.getLogger(__name__)


VLLMState = Literal["stopped", "starting", "downloading", "ready", "failed"]


class VLLMNotInstalledError(RuntimeError):
    """Raised when the `vllm` CLI is not on PATH (the [gpu] extra wasn't synced)."""


@dataclass
class _VLLMState:
    process: subprocess.Popen[bytes] | None = None
    state: VLLMState = "stopped"
    model: str | None = None
    port: int | None = None
    base_url: str | None = None
    started_at: float | None = None  # monotonic seconds
    message: str | None = None
    log_path: Path | None = None
    poll_thread: threading.Thread | None = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)


# Module-level singleton — one vLLM per backend process.
_state = _VLLMState()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def is_vllm_installed() -> bool:
    """True when the `vllm` CLI is on PATH."""
    return shutil.which("vllm") is not None


def build_command(model: str, port: int) -> list[str]:
    """The exact `vllm serve` invocation we run (also surfaced in the UI's manual panel)."""
    return ["vllm", "serve", model, "--port", str(port)]


def start(
    project_root: Path,
    *,
    model: str,
    port: int,
) -> dict:
    """Spawn `vllm serve <model> --port <port>` as a background subprocess.

    Raises VLLMNotInstalledError if `vllm` is not on PATH.
    Raises RuntimeError("vllm_already_running") if a managed vLLM is already up.
    """
    if not is_vllm_installed():
        raise VLLMNotInstalledError(
            "The `vllm` CLI is not installed. Run `uv sync --extra gpu` "
            "to install the GPU extras, then try again."
        )

    with _state.lock:
        if _state.process is not None and _state.process.poll() is None:
            raise RuntimeError("vllm_already_running")
        # Clean any stale handle.
        _state.process = None
        _state.stop_event = threading.Event()

    base_url = f"http://localhost:{port}"
    cmd = build_command(model, port)
    env = {**os.environ, "PYTHONPATH": str(project_root)}
    logs_dir = project_root / "reports" / "history" / "vllm"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"vllm-{int(time.time())}.log"
    log_file = log_path.open("wb")

    try:
        # start_new_session=False so the subprocess shares uvicorn's process group:
        # uvicorn exiting will reap the tree, but the browser closing won't.
        process = subprocess.Popen(
            cmd,
            cwd=project_root,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=False,
        )
    except FileNotFoundError as exc:
        log_file.close()
        raise VLLMNotInstalledError(
            "The `vllm` CLI vanished between PATH check and spawn. "
            "Run `uv sync --extra gpu`."
        ) from exc

    with _state.lock:
        _state.process = process
        _state.state = "starting"
        _state.model = model
        _state.port = port
        _state.base_url = base_url
        _state.started_at = time.monotonic()
        _state.message = "Spawned vllm serve; waiting for /v1/models …"
        _state.log_path = log_path

    poll_thread = threading.Thread(
        target=_watch_until_ready,
        args=(process, base_url, log_path),
        name="vllm-watcher",
        daemon=True,
    )
    poll_thread.start()
    with _state.lock:
        _state.poll_thread = poll_thread

    logger.info("vllm started (pid=%d, model=%s, port=%d, log=%s)", process.pid, model, port, log_path)
    return _snapshot_unlocked_clone()


def stop() -> dict:
    """SIGTERM the running vLLM, if any."""
    with _state.lock:
        p = _state.process
        was_running = p is not None and p.poll() is None
        pid = p.pid if p is not None else None
        _state.stop_event.set()

    if was_running and p is not None:
        with contextlib.suppress(ProcessLookupError):
            p.send_signal(signal.SIGTERM)
        try:
            p.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            logger.warning("vllm pid=%s did not exit after SIGTERM, sending SIGKILL", pid)
            with contextlib.suppress(ProcessLookupError):
                p.kill()

    with _state.lock:
        _state.process = None
        _state.state = "stopped"
        _state.model = None
        _state.port = None
        _state.base_url = None
        _state.started_at = None
        _state.message = "Stopped." if was_running else None
        _state.log_path = None

    return {"ok": True, "was_running": was_running}


def status() -> dict:
    """Current state snapshot. Cleans up if the process exited."""
    with _state.lock:
        p = _state.process
        if p is not None and p.poll() is not None and _state.state not in ("failed", "stopped"):
            # Process died unexpectedly.
            _state.state = "failed"
            _state.message = (
                f"vllm exited with code {p.returncode}. "
                f"See {_state.log_path} for details."
            )
        return _snapshot_locked()


def reset_for_tests() -> None:
    """Test hook — clears the singleton (does NOT kill any running process)."""
    with _state.lock:
        _state.process = None
        _state.state = "stopped"
        _state.model = None
        _state.port = None
        _state.base_url = None
        _state.started_at = None
        _state.message = None
        _state.log_path = None
        _state.poll_thread = None
        _state.stop_event = threading.Event()


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


_DOWNLOAD_HINTS = re.compile(r"(downloading|fetching|loading weights)", re.IGNORECASE)


def _watch_until_ready(
    process: subprocess.Popen[bytes],
    base_url: str,
    log_path: Path,
    *,
    poll_interval_s: float = 1.0,
    timeout_s: float = 600.0,
) -> None:
    """Poll /v1/models until ready, watching the log for download progress in parallel."""
    deadline = time.monotonic() + timeout_s
    url = f"{base_url.rstrip('/')}/v1/models"

    while not _state.stop_event.is_set():
        # Did the process die?
        if process.poll() is not None:
            with _state.lock:
                if _state.process is process:
                    _state.state = "failed"
                    _state.message = (
                        f"vllm exited with code {process.returncode} before becoming ready. "
                        f"See {log_path}."
                    )
            return

        # Inspect the latest tail of the log for download hints (best-effort).
        if log_path.exists():
            try:
                tail = _read_tail(log_path, max_bytes=8192)
                if _DOWNLOAD_HINTS.search(tail):
                    with _state.lock:
                        if _state.state == "starting" and _state.process is process:
                            _state.state = "downloading"
                            _state.message = "Downloading model weights (first run can take a while)…"
            except OSError:
                pass

        # Is the server up?
        try:
            r = httpx.get(url, timeout=2.0)
            if r.status_code < 500:
                with _state.lock:
                    if _state.process is process:
                        _state.state = "ready"
                        _state.message = "vLLM is ready."
                return
        except Exception:
            pass

        if time.monotonic() > deadline:
            with _state.lock:
                if _state.process is process:
                    _state.state = "failed"
                    _state.message = f"vllm did not become ready within {int(timeout_s)}s."
            return

        time.sleep(poll_interval_s)


def _read_tail(path: Path, *, max_bytes: int = 8192) -> str:
    with path.open("rb") as fh:
        try:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode("utf-8", errors="replace")
        except OSError:
            return ""


def _snapshot_locked() -> dict:
    elapsed_s = 0.0 if _state.started_at is None else max(0.0, time.monotonic() - _state.started_at)
    return {
        "state": _state.state,
        "model": _state.model,
        "port": _state.port,
        "base_url": _state.base_url,
        "elapsed_s": elapsed_s,
        "message": _state.message,
    }


def _snapshot_unlocked_clone() -> dict:
    """Take a snapshot of state, assuming the caller did NOT hold the lock during the call.

    Used for the return value of start(): we want the post-spawn snapshot.
    """
    with _state.lock:
        return _snapshot_locked()


__all__ = [
    "VLLMNotInstalledError",
    "VLLMState",
    "build_command",
    "is_vllm_installed",
    "reset_for_tests",
    "start",
    "status",
    "stop",
]
