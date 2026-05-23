"""Tests for the config-snapshot guard (the load-bearing piece of agent_runner)."""

from __future__ import annotations

import json
from pathlib import Path

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
