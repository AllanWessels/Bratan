"""Tests for the scripts/loop.py orchestrator state machine.

We import `scripts.loop` as a module and exercise main() + helpers with all
subprocess/agent calls mocked. The orchestrator's responsibilities under test:
- iteration sequencing
- --iterations 0 baseline path
- --no-agents skips agents but runs eval
- --skip-red skips red but runs blue + eval
- stop_reason wiring (any firing reason halts the loop)
- aborting cleanly when eval produces no report
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from pipeline.agent_runner import AgentRun
from pipeline.metrics import CostBlock, IterationReport
from ui.backend.schemas import BratanConfig

# Load scripts/loop.py as a module under a stable name.
ROOT = Path(__file__).resolve().parents[1]
_loop_path = ROOT / "scripts" / "loop.py"
_spec = importlib.util.spec_from_file_location("scripts_loop", _loop_path)
loop = importlib.util.module_from_spec(_spec)
sys.modules["scripts_loop"] = loop
_spec.loader.exec_module(loop)  # type: ignore[union-attr]


def _make_report(composite: float = 0.7, usd: float = 0.0, regressions=None) -> IterationReport:
    return IterationReport(
        timestamp=datetime.now(UTC).isoformat(),
        iteration=0,
        pipeline_manifest_hash="x" * 16,
        test_set_size=1,
        composite_mean=composite,
        composite_stdev=0.0,
        pass_rate_at_0_6=1.0 if composite >= 0.6 else 0.0,
        cost=CostBlock(usd_spent=usd),
        regressions=regressions or [],
        judge_weights_hash="d" * 12,
    )


def _make_agent_run(name="blue-team", exit_code=0) -> AgentRun:
    return AgentRun(
        name=name,
        exit_code=exit_code,
        log_path=ROOT / "reports" / "history" / "agents" / "fake.log",
        started_at=datetime.now(UTC),
        duration_s=1.0,
        config_was_mutated=False,
    )


def _run_main(*argv: str) -> int:
    """Invoke loop.main() with the given argv slice."""
    with patch.object(sys, "argv", ["loop.py", *argv]):
        return loop.main()


@pytest.fixture(autouse=True)
def _stub_io(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Mock everything that touches the network, filesystem (outside tmp), or subprocesses."""
    monkeypatch.setattr(loop, "load_config", lambda _p: BratanConfig())
    monkeypatch.setattr(loop.metrics, "write_report", lambda r: tmp_path / "fake.json")
    # _commit_pipeline_changes uses subprocess.run for git; pretend no diff and no changes.
    fake = MagicMock()
    fake.returncode = 0
    monkeypatch.setattr(loop.subprocess, "run", lambda *a, **kw: fake)
    yield


# ---------------------------------------------------------------------------
# --iterations 0 (baseline)
# ---------------------------------------------------------------------------


def test_iterations_zero_runs_eval_no_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    eval_calls: list[int] = []
    agent_calls: list[str] = []

    monkeypatch.setattr(loop, "_run_eval", lambda args, iteration: (eval_calls.append(iteration) or _make_report()))
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: agent_calls.append(a[0]))

    rc = _run_main("--iterations", "0")
    assert rc == 0
    assert eval_calls == [0]
    assert agent_calls == []


def test_iterations_zero_aborts_if_eval_no_report(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop, "_run_eval", lambda args, iteration: None)
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: None)
    rc = _run_main("--iterations", "0")
    assert rc == 2


# ---------------------------------------------------------------------------
# --no-agents (eval only per iteration)
# ---------------------------------------------------------------------------


def test_no_agents_skips_agents_runs_eval_per_iter(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_calls: list[str] = []
    eval_calls: list[int] = []

    monkeypatch.setattr(
        loop, "_run_eval",
        lambda args, iteration: eval_calls.append(iteration) or _make_report(),
    )
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: agent_calls.append(a[0]))

    rc = _run_main("--iterations", "3", "--no-agents")
    assert rc == 0
    assert agent_calls == []
    assert eval_calls == [1, 2, 3]


# ---------------------------------------------------------------------------
# --skip-red but still runs blue + eval
# ---------------------------------------------------------------------------


def test_skip_red_runs_only_blue_per_iter(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_calls: list[str] = []
    monkeypatch.setattr(
        loop, "_run_eval", lambda args, iteration: _make_report(composite=0.5)
    )
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: agent_calls.append(a[0]))

    _run_main("--iterations", "1", "--skip-red")
    assert agent_calls == ["blue-team"]


def test_default_runs_red_then_blue_per_iter(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_calls: list[str] = []
    monkeypatch.setattr(loop, "_run_eval", lambda args, iteration: _make_report(composite=0.5))
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: agent_calls.append(a[0]))

    _run_main("--iterations", "2")
    assert agent_calls == ["red-team", "blue-team", "red-team", "blue-team"]


# ---------------------------------------------------------------------------
# stop_reason wiring
# ---------------------------------------------------------------------------


def test_stop_reason_halts_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """When stop_criteria.evaluate returns a reason, the loop must exit immediately."""
    eval_calls: list[int] = []
    monkeypatch.setattr(loop, "_run_eval", lambda args, iteration: eval_calls.append(iteration) or _make_report())
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: None)
    monkeypatch.setattr(loop.stop_criteria, "evaluate", lambda cfg, report, state: "max_iterations")

    rc = _run_main("--iterations", "5", "--no-agents")
    assert rc == 0
    # Should stop after the first iteration's evaluate() fires.
    assert eval_calls == [1]


def test_loop_aborts_when_eval_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop, "_run_eval", lambda args, iteration: None)
    monkeypatch.setattr(loop, "_run_agent_safe", lambda *a, **kw: None)
    rc = _run_main("--iterations", "1", "--no-agents")
    assert rc == 2


# ---------------------------------------------------------------------------
# _run_agent_safe survives errors
# ---------------------------------------------------------------------------


def test_run_agent_safe_swallows_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **kw):
        raise RuntimeError("claude not installed")

    monkeypatch.setattr(loop.agent_runner, "run_agent", boom)
    # Should not raise — failure is logged, loop continues.
    loop._run_agent_safe("blue-team", BratanConfig(), max_budget_usd=None)


def test_run_agent_safe_passes_model_and_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake_run(name, **kwargs):
        captured["name"] = name
        captured.update(kwargs)
        return _make_agent_run(name)

    monkeypatch.setattr(loop.agent_runner, "run_agent", fake_run)
    cfg = BratanConfig()
    loop._run_agent_safe("blue-team", cfg, max_budget_usd=2.0)
    assert captured["name"] == "blue-team"
    assert captured["model"] == cfg.models.oracle_model
    assert captured["max_budget_usd"] == 2.0
