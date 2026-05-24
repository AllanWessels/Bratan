"""Subprocess entry point for ingesting a corpus into the vector store.

Why this exists
---------------
ChromaDB's Rust bindings hold *process-level* state per persistent path.
Once the long-running uvicorn backend has touched a `.chroma` path, no
amount of `client.reset()` + `shutil.rmtree` + reconnect can fully clear
it within the same process — subsequent operations after a wipe-under-
live-client tend to fail with "readonly database" or
"no such table: tenants", and ingest silently degrades to
`state=succeeded` / `chunks_written=0` because every file gets skipped.

The structural fix is to never let the uvicorn process touch chromadb's
mutation API directly. This script is the short-lived child process that
owns the chromadb write path; uvicorn only communicates with it through:

1. The CLI args we hand it (config path, status path).
2. The JSON status file it writes (read by `get_ingest_status`).

When this script exits, its chromadb state goes with it. The parent
process talks to chromadb only via the read path (`vector_query`), which
doesn't poison state across calls.

CLI
---
    python -m scripts.ingest_worker \
        --config-path /path/to/bratan.config.yaml \
        --status-path /path/to/ingest_status.json

Exit code is 0 on success (state="succeeded") and 1 on hard failure
(state="failed"). The status file is always written before exit so the
parent can read terminal state.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
import traceback
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Status file shape (mirrors ui.backend.schemas.IngestStatus)
# ---------------------------------------------------------------------------


def _empty_status(task_id: str) -> dict[str, Any]:
    return {
        "state": "running",
        "task_id": task_id,
        "files_total": 0,
        "files_done": 0,
        "chunks_written": 0,
        "error": None,
        "current_file": None,
        "chunks_per_sec": None,
        # Wall-clock timestamps used by the parent to detect orphans.
        "started_at_iso": datetime.now(UTC).isoformat(),
        "updated_at_iso": datetime.now(UTC).isoformat(),
        "pid": os.getpid(),
    }


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON to `path` atomically so the parent never reads a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Progress reporter — bridges the in-process `_TASK` state to the status file
# ---------------------------------------------------------------------------


class _StatusReporter:
    """Polls `pipeline.ingest._TASK` and flushes its state to disk.

    Runs as a daemon thread so progress is visible to the parent process
    even while the embedder is mid-batch. The status file is the *only*
    cross-process channel — we keep it small and append-only-per-write.
    """

    def __init__(self, status_path: Path, task_id: str, interval: float = 0.5) -> None:
        self._status_path = status_path
        self._task_id = task_id
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_monotonic = time.monotonic()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="ingest-status-reporter", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def snapshot(self, *, state: str, error: str | None = None) -> dict[str, Any]:
        from pipeline import ingest as ingest_mod

        with ingest_mod._TASK.lock:
            files_total = ingest_mod._TASK.files_total
            files_done = ingest_mod._TASK.files_done
            chunks_written = ingest_mod._TASK.chunks_written
            current_file = ingest_mod._TASK.current_file

        elapsed = max(time.monotonic() - self._started_monotonic, 1e-6)
        chunks_per_sec: float | None = None
        if chunks_written > 0:
            chunks_per_sec = round(chunks_written / elapsed, 2)

        return {
            "state": state,
            "task_id": self._task_id,
            "files_total": files_total,
            "files_done": files_done,
            "chunks_written": chunks_written,
            "error": error,
            "current_file": current_file,
            "chunks_per_sec": chunks_per_sec,
            "started_at_iso": datetime.fromtimestamp(
                time.time() - elapsed, tz=UTC
            ).isoformat(),
            "updated_at_iso": datetime.now(UTC).isoformat(),
            "pid": os.getpid(),
        }

    def flush(self, *, state: str, error: str | None = None) -> None:
        try:
            _atomic_write_json(self._status_path, self.snapshot(state=state, error=error))
        except Exception as exc:
            logger.warning("Failed to write status file %s: %s", self._status_path, exc)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.flush(state="running")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest a corpus into the configured vector store (subprocess-isolated)."
    )
    parser.add_argument(
        "--config-path",
        required=True,
        help="Path to bratan.config.yaml (BratanConfig).",
    )
    parser.add_argument(
        "--status-path",
        required=True,
        help="Path to the JSON status file this worker should write progress to.",
    )
    parser.add_argument(
        "--task-id",
        default=None,
        help="Optional task id (used by the parent for correlation).",
    )
    return parser.parse_args(argv)


def run(config_path: Path, status_path: Path, task_id: str | None = None) -> int:
    """Run a single ingest pass and return a process exit code."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [ingest-worker] %(message)s",
    )

    tid = task_id or uuid.uuid4().hex[:12]

    # Seed the status file BEFORE we import anything heavy so a slow
    # chromadb import doesn't look like a hung worker to the parent.
    _atomic_write_json(status_path, _empty_status(tid))

    reporter = _StatusReporter(status_path, task_id=tid)

    try:
        from ui.backend.config_store import load as load_config

        cfg = load_config(Path(config_path))
    except Exception as exc:
        msg = f"Failed to load config {config_path}: {exc}"
        logger.exception(msg)
        # Reporter not started yet — write a terminal snapshot by hand.
        payload = _empty_status(tid)
        payload["state"] = "failed"
        payload["error"] = msg
        payload["updated_at_iso"] = datetime.now(UTC).isoformat()
        _atomic_write_json(status_path, payload)
        return 1

    reporter.start()
    try:
        from pipeline import ingest as ingest_mod

        # Reset the in-process task state so the reporter snapshots
        # numbers from THIS run, not whatever was sitting in module globals.
        with ingest_mod._TASK.lock:
            ingest_mod._TASK.state = "running"
            ingest_mod._TASK.task_id = tid
            ingest_mod._TASK.files_total = 0
            ingest_mod._TASK.files_done = 0
            ingest_mod._TASK.chunks_written = 0
            ingest_mod._TASK.error = None
            ingest_mod._TASK.current_file = None
            ingest_mod._TASK.started_at = time.monotonic()

        chunks_written = ingest_mod._ingest_sync(cfg)
    except Exception as exc:
        err = "".join(traceback.format_exception_only(type(exc), exc)).strip() or str(exc)
        logger.exception("Ingest worker failed")
        reporter.stop()
        reporter.flush(state="failed", error=err)
        return 1

    reporter.stop()
    # Final invariant check: if no files were processed at all the run is
    # vacuously fine (empty corpus). If files WERE processed but zero chunks
    # came out, _ingest_sync would already have raised — defensive fallback
    # here just in case a future change leaves the path open.
    from pipeline import ingest as ingest_mod

    with ingest_mod._TASK.lock:
        files_done = ingest_mod._TASK.files_done
    if files_done > 0 and chunks_written == 0:
        reporter.flush(
            state="failed",
            error=(
                "ingest produced 0 chunks despite processing "
                f"{files_done} files; the vector store likely rejected writes"
            ),
        )
        return 1

    reporter.flush(state="succeeded")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    return run(
        config_path=Path(args.config_path),
        status_path=Path(args.status_path),
        task_id=args.task_id,
    )


if __name__ == "__main__":
    raise SystemExit(main())
