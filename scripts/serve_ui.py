"""Dev-mode launcher: run the FastAPI backend and the Vite frontend together.

In production the React app builds to static assets that the FastAPI server can mount;
in dev we run them as two processes so HMR works.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT / "ui" / "frontend"


def _spawn_backend(host: str, port: int) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "ui.backend.app:app",
            "--host",
            host,
            "--port",
            str(port),
            "--reload",
        ],
        cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(ROOT)},
    )


def _spawn_frontend(port: int) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        ["npm", "run", "dev", "--", "--port", str(port)],
        cwd=FRONTEND_DIR,
    )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--backend-host", default=os.environ.get("UI_HOST", "127.0.0.1"))
    p.add_argument("--backend-port", type=int, default=int(os.environ.get("UI_PORT", "8000")))
    p.add_argument("--frontend-port", type=int, default=5173)
    p.add_argument("--backend-only", action="store_true")
    args = p.parse_args()

    procs: list[subprocess.Popen[bytes]] = []
    procs.append(_spawn_backend(args.backend_host, args.backend_port))
    if not args.backend_only and FRONTEND_DIR.exists() and (FRONTEND_DIR / "package.json").exists():
        time.sleep(1.0)
        procs.append(_spawn_frontend(args.frontend_port))
    elif not args.backend_only:
        print("[serve_ui] frontend not scaffolded yet — running backend only", file=sys.stderr)

    def _shutdown(*_: object) -> None:
        for proc in procs:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    signal.signal(signal.SIGINT, lambda *_: (_shutdown(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (_shutdown(), sys.exit(0)))

    try:
        while True:
            for proc in procs:
                if proc.poll() is not None:
                    print(f"[serve_ui] process exited with code {proc.returncode}", file=sys.stderr)
                    _shutdown()
                    return proc.returncode or 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        _shutdown()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
