"""Tests for the config-snapshot guard and the `claude` CLI invocation shape."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import pipeline.agent_runner as agent_runner


@pytest.fixture
def fake_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = tmp_path / "bratan.config.yaml"
    side = tmp_path / ".bratan-setup.json"
    monkeypatch.setattr(agent_runner, "USER_CONFIG", cfg)
    monkeypatch.setattr(agent_runner, "SETUP_SIDECAR", side)
    return tmp_path


def test_snapshot_reverts_mutation(fake_paths: Path) -> None:
    agent_runner.USER_CONFIG.write_text("project:\n  seed_target_n: 50\n")
    with agent_runner.config_snapshot_guard() as mutated:
        agent_runner.USER_CONFIG.write_text("project:\n  seed_target_n: 9999\n")
    assert mutated["value"] is True
    assert "seed_target_n: 50" in agent_runner.USER_CONFIG.read_text()


def test_snapshot_passes_through_no_mutation(fake_paths: Path) -> None:
    agent_runner.USER_CONFIG.write_text("project:\n  seed_target_n: 50\n")
    with agent_runner.config_snapshot_guard() as mutated:
        pass
    assert mutated["value"] is False
    assert "seed_target_n: 50" in agent_runner.USER_CONFIG.read_text()


def test_snapshot_removes_agent_created_config(fake_paths: Path) -> None:
    # USER_CONFIG does not exist beforehand
    assert not agent_runner.USER_CONFIG.exists()
    with agent_runner.config_snapshot_guard() as mutated:
        agent_runner.USER_CONFIG.write_text("rogue: true\n")
    assert mutated["value"] is True
    assert not agent_runner.USER_CONFIG.exists()


def test_snapshot_reverts_sidecar(fake_paths: Path) -> None:
    agent_runner.SETUP_SIDECAR.write_text(json.dumps({"current_step": 4}))
    with agent_runner.config_snapshot_guard() as mutated:
        agent_runner.SETUP_SIDECAR.write_text(json.dumps({"current_step": 99}))
    assert mutated["value"] is True
    assert json.loads(agent_runner.SETUP_SIDECAR.read_text())["current_step"] == 4


# ---------------------------------------------------------------------------
# claude CLI invocation shape
# ---------------------------------------------------------------------------


def test_run_agent_builds_expected_cmd(monkeypatch: pytest.MonkeyPatch) -> None:
    """The constructed cmd must match the flags verified against `claude --help`."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs.get("cwd")
        m = MagicMock()
        m.returncode = 0
        return m

    monkeypatch.setattr(subprocess, "run", fake_run)

    run = agent_runner.run_agent(
        "judge",
        model="claude-sonnet-4-6",
        max_budget_usd=2.5,
    )

    cmd = captured["cmd"]
    # Required positional CLI
    assert cmd[0] == "claude"
    assert "-p" in cmd
    assert "--bare" in cmd
    # Lane: system prompt comes from the agent's AGENTS.md
    sp_idx = cmd.index("--system-prompt-file")
    assert cmd[sp_idx + 1].endswith("agents/judge/AGENTS.md")
    # Filesystem scoping
    add_idx = cmd.index("--add-dir")
    assert Path(cmd[add_idx + 1]) == agent_runner.PROJECT_ROOT
    # Model + budget pass-through
    model_idx = cmd.index("--model")
    assert cmd[model_idx + 1] == "claude-sonnet-4-6"
    budget_idx = cmd.index("--max-budget-usd")
    assert cmd[budget_idx + 1] == "2.5"
    # Sandbox / output shape
    assert "--dangerously-skip-permissions" in cmd
    out_idx = cmd.index("--output-format")
    assert cmd[out_idx + 1] == "json"
    # Final positional is the kickoff prompt
    assert cmd[-1] == agent_runner._DEFAULT_KICKOFF
    # Return shape
    assert run.exit_code == 0
    assert run.name == "judge"


def test_run_agent_missing_claude_returns_127(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_not_found(cmd, **kwargs):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(subprocess, "run", raise_not_found)
    run = agent_runner.run_agent("red-team")
    assert run.exit_code == 127


def test_run_agent_unknown_lane_raises() -> None:
    with pytest.raises(FileNotFoundError, match="No system prompt"):
        agent_runner.run_agent("nonexistent")  # type: ignore[arg-type]
