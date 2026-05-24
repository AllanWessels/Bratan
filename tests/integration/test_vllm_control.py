"""Integration: managed vLLM lifecycle endpoints.

Two scenarios:

1. `vllm` is NOT installed (CLI not on PATH) — POST /api/system/vllm/start should
   return 422 with a clear "run `uv sync --extra gpu`" message and not leave any
   subprocess state behind.

2. `vllm` IS installed (we mock `shutil.which` and `subprocess.Popen` with a fake
   process that writes "downloading" then later responds to /v1/models) — start
   transitions starting -> downloading -> ready as we feed events; stop tears it
   down cleanly.

We never actually spawn the real `vllm` binary — these tests run on CI machines
without GPUs / vLLM weights.
"""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from ui.backend import app as app_mod
    from ui.backend import vllm_control

    monkeypatch.setattr(app_mod, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(app_mod, "CONFIG_PATH", tmp_path / "bratan.config.yaml")
    (tmp_path / "reports" / "history" / "vllm").mkdir(parents=True, exist_ok=True)
    vllm_control.reset_for_tests()
    return TestClient(app_mod.app)


# ---------------------------------------------------------------------------
# 1. Not installed
# ---------------------------------------------------------------------------


def test_start_without_vllm_returns_422(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from ui.backend import vllm_control

    monkeypatch.setattr(vllm_control.shutil, "which", lambda _name: None)

    r = client.post(
        "/api/system/vllm/start",
        json={"model": "Qwen/Qwen2.5-7B-Instruct-AWQ", "port": 8001},
    )
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "vllm_not_installed"
    # Make sure the message tells the user the exact fix.
    msg = (detail["message"] + " " + detail.get("hint", "")).lower()
    assert "uv sync" in msg
    assert "--extra gpu" in msg

    # No subprocess state should have been recorded.
    s = client.get("/api/system/vllm/status").json()
    assert s["state"] == "stopped"
    assert s["model"] is None


def test_status_endpoint_starts_stopped(client: TestClient) -> None:
    r = client.get("/api/system/vllm/status")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "stopped"
    assert body["model"] is None
    assert body["port"] is None
    assert body["elapsed_s"] == 0.0


# ---------------------------------------------------------------------------
# 2. Installed — mock the Popen handle
# ---------------------------------------------------------------------------


class _FakePopen:
    """Stand-in for subprocess.Popen used in tests.

    The watcher thread polls .poll() and the /v1/models endpoint. We expose
    `simulate_ready_at_url(url)` via a patched httpx.get so we can decide when
    the fake server "comes up".
    """

    def __init__(self) -> None:
        self.pid = 99999
        self.returncode: int | None = None
        self._terminated = threading.Event()
        self.signals_received: list[int] = []

    def poll(self) -> int | None:
        return self.returncode

    def send_signal(self, sig: int) -> None:
        self.signals_received.append(sig)
        self.returncode = -sig
        self._terminated.set()

    def kill(self) -> None:
        self.returncode = -9
        self._terminated.set()

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self._terminated.wait(timeout)
        if self.returncode is None:
            raise subprocess.TimeoutExpired(cmd=["vllm"], timeout=timeout or 0.0)
        return self.returncode


class _FakeHttpResponse:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def test_start_with_mocked_vllm_reaches_ready(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from ui.backend import vllm_control

    # 1. Pretend `vllm` is on PATH.
    monkeypatch.setattr(vllm_control.shutil, "which", lambda _name: "/usr/local/bin/vllm")

    fake = _FakePopen()
    spawned: dict = {}

    def fake_popen(cmd, **kwargs):
        spawned["cmd"] = cmd
        spawned["cwd"] = kwargs.get("cwd")
        # Don't actually write to the log; we don't need it for the green-path test.
        return fake

    monkeypatch.setattr(vllm_control.subprocess, "Popen", fake_popen)

    # The watcher thread polls /v1/models — flip the response over time.
    ready_event = threading.Event()

    def fake_httpx_get(url: str, *, timeout: float = 1.0):
        if ready_event.is_set() and "/v1/models" in url:
            return _FakeHttpResponse(200, '{"data":[]}')
        raise vllm_control.httpx.ConnectError("not ready yet")

    monkeypatch.setattr(vllm_control.httpx, "get", fake_httpx_get)

    # 2. Kick off start.
    r = client.post(
        "/api/system/vllm/start",
        json={"model": "Qwen/Qwen2.5-7B-Instruct-AWQ", "port": 8011},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Immediately after start we should be in "starting" (or possibly already
    # "downloading"/"ready" if the watcher is fast — but ready needs httpx to
    # succeed, which we haven't toggled yet).
    assert body["state"] in {"starting", "downloading"}
    assert body["model"] == "Qwen/Qwen2.5-7B-Instruct-AWQ"
    assert body["port"] == 8011
    assert body["base_url"] == "http://localhost:8011"
    assert spawned["cmd"][0] == "vllm"
    assert "serve" in spawned["cmd"]

    # 3. Trying to start a second one should 409.
    r2 = client.post(
        "/api/system/vllm/start",
        json={"model": "Qwen/Qwen2.5-7B-Instruct-AWQ", "port": 8012},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"]["error"] == "vllm_already_running"

    # 4. Let the fake server "come up". Poll status until ready (bounded wait).
    ready_event.set()
    deadline = time.monotonic() + 5.0
    final = None
    while time.monotonic() < deadline:
        final = client.get("/api/system/vllm/status").json()
        if final["state"] == "ready":
            break
        time.sleep(0.1)
    assert final is not None
    assert final["state"] == "ready", final
    assert final["elapsed_s"] >= 0.0

    # 5. Stop tears it down.
    r3 = client.post("/api/system/vllm/stop")
    assert r3.status_code == 200
    assert r3.json() == {"ok": True, "was_running": True}
    s = client.get("/api/system/vllm/status").json()
    assert s["state"] == "stopped"


def test_start_with_dying_process_transitions_to_failed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If `vllm serve` exits immediately, status should land on 'failed'."""
    from ui.backend import vllm_control

    monkeypatch.setattr(vllm_control.shutil, "which", lambda _name: "/usr/local/bin/vllm")

    fake = _FakePopen()
    fake.returncode = 1  # Already dead by the time the watcher polls.

    monkeypatch.setattr(vllm_control.subprocess, "Popen", lambda *a, **kw: fake)
    monkeypatch.setattr(
        vllm_control.httpx,
        "get",
        lambda *a, **kw: (_ for _ in ()).throw(vllm_control.httpx.ConnectError("nope")),
    )

    r = client.post(
        "/api/system/vllm/start", json={"model": "X/Y", "port": 8099}
    )
    assert r.status_code == 200

    # The watcher checks .poll() at the top of the loop, so within a couple of
    # ticks state must flip to "failed".
    deadline = time.monotonic() + 3.0
    final = None
    while time.monotonic() < deadline:
        final = client.get("/api/system/vllm/status").json()
        if final["state"] == "failed":
            break
        time.sleep(0.1)
    assert final is not None
    assert final["state"] == "failed", final
    assert "exited" in (final["message"] or "").lower()


def test_build_command_matches_manual_copy_paste() -> None:
    """The CLI string we surface in the UI's 'Show me the command' panel."""
    from ui.backend.vllm_control import build_command

    cmd = build_command("Qwen/Qwen2.5-7B-Instruct-AWQ", 8001)
    assert cmd == ["vllm", "serve", "Qwen/Qwen2.5-7B-Instruct-AWQ", "--port", "8001"]
