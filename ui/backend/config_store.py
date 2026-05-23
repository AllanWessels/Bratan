"""Reads/writes `bratan.config.yaml` and the setup-sidecar.

Two files are touched:
- `bratan.config.yaml` — the authoritative project config (BratanConfig).
- `.bratan-setup.json` — sidecar tracking which wizard steps the user completed.

All writes are atomic (tmp file + os.replace) and serialize through a process-
wide lock to avoid concurrent corruption from parallel HTTP requests.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from ui.backend.schemas import BratanConfig, SaveStepResponse, SetupState

logger = logging.getLogger(__name__)

_WRITE_LOCK = threading.Lock()
_SIDECAR_NAME = ".bratan-setup.json"


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------


def get_setup_state(path: Path) -> SetupState:
    sidecar = _read_sidecar(path)
    config_exists = path.exists()
    setup_completed = False
    if config_exists:
        try:
            setup_completed = bool(load(path).setup_completed)
        except Exception as exc:
            logger.warning("Could not read config at %s: %s", path, exc)

    completed_steps: list[int] = sorted(set(sidecar.get("completed_steps", [])))
    current_step = sidecar.get("current_step")
    if not isinstance(current_step, int):
        current_step = (max(completed_steps) + 1) if completed_steps else 1
    current_step = max(1, min(8, current_step))

    return SetupState(
        config_exists=config_exists,
        setup_completed=setup_completed,
        current_step=current_step,
        total_steps=8,
        completed_steps=completed_steps,
    )


def load(path: Path) -> BratanConfig:
    """Load config; return defaults if the file doesn't exist or is malformed."""
    if not path.exists():
        return BratanConfig()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            logger.warning("Config at %s is not a mapping; using defaults.", path)
            return BratanConfig()
        return BratanConfig.model_validate(raw)
    except Exception as exc:
        logger.warning("Could not parse %s, returning defaults: %s", path, exc)
        return BratanConfig()


def save_step(path: Path, step: int, data: dict[str, Any]) -> SaveStepResponse:
    """Merge `data` into the current config and mark the step complete."""
    with _WRITE_LOCK:
        current = load(path).model_dump(mode="json")
        merged = _deep_merge(current, data)
        updated = BratanConfig.model_validate(merged)
        _write_config(path, updated)

        sidecar = _read_sidecar(path)
        completed = set(sidecar.get("completed_steps", []))
        completed.add(int(step))
        sidecar["completed_steps"] = sorted(completed)
        sidecar["current_step"] = max(1, min(8, int(step) + 1))
        _write_sidecar(path, sidecar)

    return SaveStepResponse(ok=True, config=updated)


def finish_setup(path: Path) -> BratanConfig:
    with _WRITE_LOCK:
        current = load(path)
        updated = current.model_copy(
            update={
                "setup_completed": True,
                "setup_completed_at": datetime.now(UTC),
            }
        )
        _write_config(path, updated)
        sidecar = _read_sidecar(path)
        sidecar["completed_steps"] = sorted(set(sidecar.get("completed_steps", []) + list(range(1, 9))))
        sidecar["current_step"] = 8
        _write_sidecar(path, sidecar)
    return updated


def patch(path: Path, patch_data: dict[str, Any]) -> BratanConfig:
    with _WRITE_LOCK:
        current = load(path).model_dump(mode="json")
        merged = _deep_merge(current, patch_data)
        updated = BratanConfig.model_validate(merged)
        _write_config(path, updated)
    return updated


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _write_config(path: Path, cfg: BratanConfig) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = yaml.safe_dump(
        cfg.model_dump(mode="json"),
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
    )
    _atomic_write(path, serialized)


def _read_sidecar(config_path: Path) -> dict[str, Any]:
    sidecar = config_path.parent / _SIDECAR_NAME
    if not sidecar.exists():
        return {}
    try:
        return json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not parse sidecar %s: %s", sidecar, exc)
        return {}


def _write_sidecar(config_path: Path, data: dict[str, Any]) -> None:
    sidecar = config_path.parent / _SIDECAR_NAME
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(sidecar, json.dumps(data, indent=2, sort_keys=True))


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursive dict merge; overlay wins on conflicts."""
    out = dict(base)
    for k, v in overlay.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out
