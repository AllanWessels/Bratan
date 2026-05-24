"""Tests for ui.backend.config_store: load/save_step/patch/finish, atomic write, deep merge."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from ui.backend.config_store import (
    _deep_merge,
    finish_setup,
    get_setup_state,
    load,
    patch,
    save_step,
)


@pytest.fixture
def cfg_path(tmp_path: Path) -> Path:
    return tmp_path / "bratan.config.yaml"


# ---------------------------------------------------------------------------
# load
# ---------------------------------------------------------------------------


def test_load_missing_file_returns_defaults(cfg_path: Path) -> None:
    assert not cfg_path.exists()
    cfg = load(cfg_path)
    assert cfg.project.project_name == "bratan"
    assert cfg.project.seed_target_n == 50
    assert cfg.vector_db.adapter.value == "chroma"


def test_load_malformed_yaml_returns_defaults(cfg_path: Path) -> None:
    cfg_path.write_text(":::not yaml at all:::\n  - [")
    cfg = load(cfg_path)
    assert cfg.project.seed_target_n == 50


def test_load_non_mapping_returns_defaults(cfg_path: Path) -> None:
    cfg_path.write_text("- list\n- of\n- things\n")
    cfg = load(cfg_path)
    assert cfg.project.seed_target_n == 50


# ---------------------------------------------------------------------------
# save_step
# ---------------------------------------------------------------------------


def test_save_step_merges_data(cfg_path: Path) -> None:
    resp = save_step(
        cfg_path,
        step=1,
        data={"project": {"project_name": "alpha", "seed_target_n": 20}},
    )
    assert resp.ok is True
    assert resp.config.project.project_name == "alpha"
    assert resp.config.project.seed_target_n == 20
    # untouched defaults survive
    assert resp.config.vector_db.adapter.value == "chroma"


def test_save_step_records_completion(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "x"}})
    state = get_setup_state(cfg_path)
    assert 1 in state.completed_steps
    assert state.current_step == 2


def test_save_step_is_additive_across_steps(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "alpha"}})
    save_step(cfg_path, step=5, data={"project": {"seed_target_n": 33}})
    cfg = load(cfg_path)
    assert cfg.project.project_name == "alpha"
    assert cfg.project.seed_target_n == 33
    state = get_setup_state(cfg_path)
    assert set(state.completed_steps) == {1, 5}


def test_save_step_persists_to_disk_as_yaml(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "zeta"}})
    on_disk = yaml.safe_load(cfg_path.read_text())
    assert on_disk["project"]["project_name"] == "zeta"


# ---------------------------------------------------------------------------
# patch
# ---------------------------------------------------------------------------


def test_patch_merges_nested(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "alpha"}})
    out = patch(cfg_path, {"cost": {"usd_per_run": 9.99}})
    assert out.cost.usd_per_run == 9.99
    assert out.project.project_name == "alpha"


def test_patch_does_not_mark_step_complete(cfg_path: Path) -> None:
    patch(cfg_path, {"project": {"project_name": "x"}})
    state = get_setup_state(cfg_path)
    assert state.completed_steps == []


# ---------------------------------------------------------------------------
# finish_setup
# ---------------------------------------------------------------------------


def test_finish_setup_marks_complete(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "alpha"}})
    out = finish_setup(cfg_path)
    assert out.setup_completed is True
    assert out.setup_completed_at is not None
    state = get_setup_state(cfg_path)
    assert state.setup_completed is True
    assert set(state.completed_steps) >= set(range(1, 9))


# ---------------------------------------------------------------------------
# Deep merge invariants
# ---------------------------------------------------------------------------


def test_deep_merge_replaces_leaf_scalars() -> None:
    out = _deep_merge({"a": {"b": 1}}, {"a": {"b": 2}})
    assert out == {"a": {"b": 2}}


def test_deep_merge_preserves_unspecified_siblings() -> None:
    out = _deep_merge({"a": {"b": 1, "c": 9}}, {"a": {"b": 2}})
    assert out == {"a": {"b": 2, "c": 9}}


def test_deep_merge_overlay_lists_replace_base() -> None:
    out = _deep_merge({"x": [1, 2]}, {"x": [9]})
    assert out == {"x": [9]}


# ---------------------------------------------------------------------------
# Atomic write — no partial file visible after a write
# ---------------------------------------------------------------------------


def test_atomic_write_leaves_no_tmp_file(cfg_path: Path) -> None:
    save_step(cfg_path, step=1, data={"project": {"project_name": "alpha"}})
    leftovers = [p for p in cfg_path.parent.iterdir() if p.suffix == ".tmp"]
    assert leftovers == []


def test_get_setup_state_initial(cfg_path: Path) -> None:
    state = get_setup_state(cfg_path)
    assert state.config_exists is False
    assert state.setup_completed is False
    assert state.current_step == 1
    assert state.total_steps == 8
    assert state.completed_steps == []
