"""Loop process control — start / stop / status for `scripts/loop.py`.

This module owns the lifecycle of the subprocess that runs the orchestrator. Only
one loop can run at a time per project. Callers go through `start()`, `stop()`,
and `status()`.

The "current_iteration" field is best-effort: we parse it out of the most recent
report on /reports/latest.json (mtime + payload). Streaming of per-iteration
events to clients lives in the FastAPI route layer (it polls latest.json's mtime
while a WebSocket subscriber is connected).
"""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class LoopControlState:
    process: subprocess.Popen[bytes] | None = None
    task_id: str | None = None
    started_at: str | None = None
    iterations_requested: int = 0
    last_report_ts: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


# Module-level singleton — one loop per backend process.
_state = LoopControlState()


def _reports_dir(project_root: Path) -> Path:
    return project_root / "reports"


def _latest_report_path(project_root: Path) -> Path:
    return _reports_dir(project_root) / "latest.json"


def is_running() -> bool:
    """True when a loop subprocess is alive."""
    with _state.lock:
        p = _state.process
        if p is None:
            return False
        if p.poll() is None:
            return True
        # Process exited — clear state so a new loop can start.
        _state.process = None
        _state.task_id = None
        _state.started_at = None
        return False


def start(
    project_root: Path,
    *,
    iterations: int,
    budget_usd: float | None,
    skip_red: bool,
    no_agents: bool,
) -> dict:
    """Spawn `scripts/loop.py` as a background subprocess.

    Raises RuntimeError if a loop is already running.
    """
    if is_running():
        raise RuntimeError("loop_already_running")

    cmd = [
        sys.executable,
        str(project_root / "scripts" / "loop.py"),
        "--iterations",
        str(iterations),
    ]
    if budget_usd is not None:
        cmd.extend(["--budget-usd", str(budget_usd)])
    if skip_red:
        cmd.append("--skip-red")
    if no_agents:
        cmd.append("--no-agents")

    env = {**os.environ, "PYTHONPATH": str(project_root)}
    logs_dir = project_root / "reports" / "history" / "agents"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"loop-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.log"
    log_file = log_path.open("wb")

    process = subprocess.Popen(
        cmd,
        cwd=project_root,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    started_at = datetime.now(UTC).isoformat()
    task_id = str(uuid.uuid4())

    with _state.lock:
        _state.process = process
        _state.task_id = task_id
        _state.started_at = started_at
        _state.iterations_requested = iterations
        _state.last_report_ts = _peek_latest_report_ts(project_root)

    logger.info("loop started (task_id=%s, pid=%d, log=%s)", task_id, process.pid, log_path)
    return {"task_id": task_id, "started_at": started_at}


def stop() -> dict:
    """Send SIGTERM to the running loop, if any."""
    with _state.lock:
        p = _state.process
        if p is None or p.poll() is not None:
            _state.process = None
            return {"ok": True, "was_running": False}
        pid = p.pid
    # Send SIGTERM outside the lock so a quick exit doesn't deadlock the cleanup.
    with contextlib.suppress(ProcessLookupError):
        p.send_signal(signal.SIGTERM)
    # Give it a chance to exit cleanly — best-effort, non-blocking past 3s.
    try:
        p.wait(timeout=3.0)
    except subprocess.TimeoutExpired:
        logger.warning("loop pid=%d did not exit after SIGTERM, sending SIGKILL", pid)
        with contextlib.suppress(ProcessLookupError):
            p.kill()
    with _state.lock:
        _state.process = None
    return {"ok": True, "was_running": True}


def status(project_root: Path) -> dict:
    running = is_running()
    last_report_ts = _peek_latest_report_ts(project_root)
    current_iteration = _peek_current_iteration(project_root)
    with _state.lock:
        return {
            "running": running,
            "task_id": _state.task_id if running else None,
            "current_iteration": current_iteration,
            "started_at": _state.started_at if running else None,
            "iterations_requested": _state.iterations_requested if running else 0,
            "last_report_ts": last_report_ts,
        }


def _peek_latest_report_ts(project_root: Path) -> str | None:
    path = _latest_report_path(project_root)
    if not path.exists():
        return None
    try:
        import json

        return json.loads(path.read_text(encoding="utf-8")).get("timestamp")
    except Exception:
        return None


def _peek_current_iteration(project_root: Path) -> int | None:
    path = _latest_report_path(project_root)
    if not path.exists():
        return None
    try:
        import json

        return json.loads(path.read_text(encoding="utf-8")).get("iteration")
    except Exception:
        return None


def latest_report_mtime(project_root: Path) -> float | None:
    path = _latest_report_path(project_root)
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return None


def read_latest_report(project_root: Path) -> dict | None:
    path = _latest_report_path(project_root)
    if not path.exists():
        return None
    try:
        import json

        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("could not read latest.json: %s", exc)
        return None


def reset_for_tests() -> None:
    """Test hook — clears the singleton (does not kill any running process)."""
    with _state.lock:
        _state.process = None
        _state.task_id = None
        _state.started_at = None
        _state.iterations_requested = 0
        _state.last_report_ts = None


__all__ = [
    "LoopControlState",
    "is_running",
    "latest_report_mtime",
    "read_latest_report",
    "reset_for_tests",
    "start",
    "status",
    "stop",
]


# Small convenience for any external code that wants to import the time module.
_ = time
