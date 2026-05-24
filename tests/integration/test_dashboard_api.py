"""Integration: dashboard read endpoints + loop control surface (M2).

Hermetic — uses tmp_project fixture, no subprocess actually spawned (we monkeypatch
`loop_control.start` to a no-op).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_project: Path, monkeypatch: pytest.MonkeyPatch):
    from ui.backend import app as app_mod
    from ui.backend import loop_control

    monkeypatch.setattr(app_mod, "PROJECT_ROOT", tmp_project)
    monkeypatch.setattr(app_mod, "CONFIG_PATH", tmp_project / "bratan.config.yaml")
    monkeypatch.setattr(app_mod, "REPORTS_DIR", tmp_project / "reports")
    loop_control.reset_for_tests()
    return TestClient(app_mod.app)


def _fake_report(iteration: int, timestamp: str, composite: float = 0.7) -> dict:
    return {
        "timestamp": timestamp,
        "iteration": iteration,
        "pipeline_manifest_hash": "abc123",
        "test_set_size": 5,
        "composite_mean": composite,
        "composite_stdev": 0.05,
        "pass_rate_at_0_6": 0.8,
        "per_category": {
            "straightforward": {"count": 3, "avg_composite": 0.75, "pass_rate": 1.0},
            "multi_hop": {"count": 2, "avg_composite": 0.4, "pass_rate": 0.5},
        },
        "regressions": [],
        "recoveries": [],
        "by_case": [],
        "cost": {
            "oracle_calls": 5,
            "prejudge_calls": 0,
            "cache_hits": 0,
            "usd_spent": 0.02,
            "tokens_in": 100,
            "tokens_out": 50,
        },
        "latency": {
            "p50_total_ms": 120.0,
            "p95_total_ms": 250.0,
            "p50_retrieval_ms": 10.0,
            "p95_retrieval_ms": 20.0,
            "p50_generation_ms": 100.0,
            "p95_generation_ms": 200.0,
        },
        "drift": {"samples_checked": 0, "disagreement_rate": 0.0},
        "judge_weights_hash": "weights1",
        "low_confidence_verdicts": [],
        "stop_reason": None,
    }


def _write_report(tmp_project: Path, payload: dict) -> None:
    reports = tmp_project / "reports"
    history = reports / "history"
    history.mkdir(parents=True, exist_ok=True)
    stem = "run-" + payload["timestamp"].replace(":", "-").replace(".", "-")
    (history / f"{stem}.json").write_text(json.dumps(payload), encoding="utf-8")
    (reports / "latest.json").write_text(json.dumps(payload), encoding="utf-8")


def test_reports_latest_404_when_empty(client) -> None:
    r = client.get("/api/reports/latest")
    assert r.status_code == 404


def test_reports_latest_returns_full_payload(client, tmp_project: Path) -> None:
    payload = _fake_report(1, "2026-05-23T10:00:00+00:00")
    _write_report(tmp_project, payload)
    r = client.get("/api/reports/latest")
    assert r.status_code == 200
    body = r.json()
    assert body["iteration"] == 1
    assert body["composite_mean"] == pytest.approx(0.7)
    assert "per_category" in body
    assert "cost" in body and "latency" in body


def test_reports_history_summaries_sorted_newest_first(client, tmp_project: Path) -> None:
    _write_report(tmp_project, _fake_report(1, "2026-05-23T10:00:00+00:00", composite=0.5))
    _write_report(tmp_project, _fake_report(2, "2026-05-23T11:00:00+00:00", composite=0.6))
    _write_report(tmp_project, _fake_report(3, "2026-05-23T12:00:00+00:00", composite=0.7))
    r = client.get("/api/reports/history")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 3
    assert rows[0]["iteration"] == 3
    assert rows[-1]["iteration"] == 1
    # Each row carries the summary fields.
    for row in rows:
        assert {"timestamp", "iteration", "composite_mean", "pass_rate_at_0_6", "stop_reason"} <= row.keys()


def test_reports_by_timestamp_found(client, tmp_project: Path) -> None:
    payload = _fake_report(7, "2026-05-23T13:00:00+00:00")
    _write_report(tmp_project, payload)
    r = client.get("/api/reports/2026-05-23T13:00:00+00:00")
    assert r.status_code == 200
    assert r.json()["iteration"] == 7


def test_reports_by_timestamp_missing(client) -> None:
    r = client.get("/api/reports/2099-01-01T00:00:00+00:00")
    assert r.status_code == 404


def test_loop_status_idle_when_nothing_running(client) -> None:
    r = client.get("/api/loop/status")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is False
    assert body["task_id"] is None
    assert body["started_at"] is None


def test_loop_start_then_stop(client, monkeypatch: pytest.MonkeyPatch) -> None:
    # Stub the subprocess spawn so we don't actually launch loop.py here.
    class _DummyProc:
        def __init__(self) -> None:
            self._alive = True
            self.pid = 99999

        def poll(self):
            return None if self._alive else 0

        def send_signal(self, _sig):
            self._alive = False

        def wait(self, timeout=None):
            self._alive = False
            return 0

        def kill(self):
            self._alive = False

    from ui.backend import loop_control

    def fake_popen(*_a, **_kw):
        return _DummyProc()

    monkeypatch.setattr(loop_control.subprocess, "Popen", fake_popen)

    r = client.post(
        "/api/loop/start",
        json={"iterations": 1, "budget_usd": None, "skip_red": True, "no_agents": True},
    )
    assert r.status_code == 200, r.text
    started = r.json()
    assert "task_id" in started and "started_at" in started

    r = client.get("/api/loop/status")
    assert r.json()["running"] is True

    # Second start while running -> 409
    r = client.post(
        "/api/loop/start",
        json={"iterations": 1, "budget_usd": None, "skip_red": True, "no_agents": True},
    )
    assert r.status_code == 409

    r = client.post("/api/loop/stop")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["was_running"] is True

    r = client.get("/api/loop/status")
    assert r.json()["running"] is False


def test_loop_stream_route_registered() -> None:
    # WebSocket subscriptions are exercised by the frontend; here we just assert
    # the route exists in the FastAPI app surface.
    from ui.backend.app import app

    paths = {route.path for route in app.routes if hasattr(route, "path")}
    assert "/api/loop/stream" in paths
