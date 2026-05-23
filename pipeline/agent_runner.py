"""Spawn an agent (red-team / blue-team / judge) as a subprocess and enforce lanes.

Each agent has a system prompt at `agents/<name>/AGENTS.md`. We:
1. Snapshot the user-owned `bratan.config.yaml` before invoking the agent.
2. Invoke `claude` (Claude Code CLI) with the right CWD + system prompt + lane.
3. Capture stdout/stderr to `/reports/history/agents/<ts>-<name>.log`.
4. Restore `bratan.config.yaml` from the snapshot — blue team must never touch
   the user-owned config; this guard makes drift impossible regardless of agent
   behavior.

`claude` flags chosen (verified against `claude --help` v2.1.150):
- `-p` / `--print`                       headless, prints once and exits
- `--system-prompt-file`                 the AGENTS.md for the lane
- `--bare`                               minimal mode (no hooks/plugins/auto-memory)
- `--add-dir <PROJECT_ROOT>`             scope filesystem access to the project
- `--model`                              defaults to Sonnet 4 from bratan.config.yaml
- `--max-budget-usd`                     enforces a per-agent spend ceiling
- `--output-format json`                 structured exit for the orchestrator
- `--dangerously-skip-permissions`       agents run unattended; sandboxed by --add-dir.
                                          The help text endorses this for sandboxed
                                          headless runs. We pair it with --add-dir to
                                          keep the blast radius scoped.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
HISTORY_DIR = PROJECT_ROOT / "reports" / "history" / "agents"
USER_CONFIG = PROJECT_ROOT / "bratan.config.yaml"
SETUP_SIDECAR = PROJECT_ROOT / ".bratan-setup.json"

AgentName = Literal["red-team", "blue-team", "judge"]


@dataclass
class AgentRun:
    name: AgentName
    exit_code: int
    log_path: Path
    started_at: datetime
    duration_s: float
    config_was_mutated: bool  # True if the agent tried to edit bratan.config.yaml


# ---------------------------------------------------------------------------
# Snapshot guard
# ---------------------------------------------------------------------------


@contextmanager
def config_snapshot_guard():
    """Snapshot bratan.config.yaml + .bratan-setup.json; restore after exit.

    The boundary between agent lanes is load-bearing: blue team must never
    touch user-owned config. The plan calls this risk #7. This context manager
    enforces it cheaply.
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="bratan-config-snap-"))
    snap_cfg = tmp_dir / "bratan.config.yaml"
    snap_side = tmp_dir / ".bratan-setup.json"
    cfg_existed = USER_CONFIG.exists()
    side_existed = SETUP_SIDECAR.exists()
    if cfg_existed:
        shutil.copy2(USER_CONFIG, snap_cfg)
    if side_existed:
        shutil.copy2(SETUP_SIDECAR, snap_side)
    mutated = {"value": False}
    try:
        yield mutated
    finally:
        # Restore — agent's edits to user-owned files are silently reverted.
        try:
            if cfg_existed and not _files_equal(snap_cfg, USER_CONFIG):
                mutated["value"] = True
                shutil.copy2(snap_cfg, USER_CONFIG)
                logger.warning("Reverted unauthorized edit to %s", USER_CONFIG.name)
            elif not cfg_existed and USER_CONFIG.exists():
                mutated["value"] = True
                USER_CONFIG.unlink()
                logger.warning("Removed agent-created %s (user-owned file)", USER_CONFIG.name)
            if side_existed and not _files_equal(snap_side, SETUP_SIDECAR):
                mutated["value"] = True
                shutil.copy2(snap_side, SETUP_SIDECAR)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _files_equal(a: Path, b: Path) -> bool:
    if not a.exists() or not b.exists():
        return False
    return a.read_bytes() == b.read_bytes()


# ---------------------------------------------------------------------------
# Subprocess invocation
# ---------------------------------------------------------------------------


_DEFAULT_KICKOFF = "Begin your work as specified in your system prompt."


def run_agent(
    name: AgentName,
    *,
    model: str | None = None,
    max_budget_usd: float | None = None,
    kickoff_prompt: str = _DEFAULT_KICKOFF,
    extra_args: list[str] | None = None,
    cwd: Path = PROJECT_ROOT,
    timeout_s: float | None = None,
    skip_permissions: bool = True,
) -> AgentRun:
    """Invoke `claude` headlessly with the named agent's AGENTS.md as system prompt.

    The CLI surface is verified against `claude --help` (v2.1.150). See module
    docstring for the chosen flags and rationale. The snapshot guard wraps the
    subprocess so any unauthorized mutation of the user-owned config is reverted.
    """
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    system_prompt_path = PROJECT_ROOT / "agents" / name / "AGENTS.md"
    if not system_prompt_path.exists():
        raise FileNotFoundError(f"No system prompt at {system_prompt_path}")

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    log_path = HISTORY_DIR / f"{stamp}-{name}.log"
    cmd: list[str] = [
        "claude",
        "-p",
        "--bare",
        "--system-prompt-file",
        str(system_prompt_path),
        "--add-dir",
        str(PROJECT_ROOT),
        "--output-format",
        "json",
    ]
    if model:
        cmd.extend(["--model", model])
    if max_budget_usd is not None:
        cmd.extend(["--max-budget-usd", str(max_budget_usd)])
    if skip_permissions:
        cmd.append("--dangerously-skip-permissions")
    if extra_args:
        cmd.extend(extra_args)
    cmd.append(kickoff_prompt)

    started = datetime.now(UTC)
    started_t = started.timestamp()

    with config_snapshot_guard() as mutated, log_path.open("w", encoding="utf-8") as log_fh:
        log_fh.write(f"# {name} @ {started.isoformat()}\n# cmd: {cmd}\n# cwd: {cwd}\n\n")
        log_fh.flush()
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                timeout=timeout_s,
                check=False,
            )
            exit_code = proc.returncode
        except FileNotFoundError:
            log_fh.write("\n[agent_runner] `claude` CLI not found on PATH.\n")
            exit_code = 127
        except subprocess.TimeoutExpired:
            log_fh.write(f"\n[agent_runner] timed out after {timeout_s}s\n")
            exit_code = 124

    duration_s = datetime.now(UTC).timestamp() - started_t
    return AgentRun(
        name=name,
        exit_code=exit_code,
        log_path=log_path,
        started_at=started,
        duration_s=duration_s,
        config_was_mutated=mutated["value"],
    )
