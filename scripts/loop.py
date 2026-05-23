"""
Orchestrator for the red-team / blue-team / judge loop.

Usage:
    uv run python scripts/loop.py --iterations 20
    uv run python scripts/loop.py --iterations 0   # judge-only baseline

This is a STUB. Claude Code should flesh it out as the first work in the
repo. The intended structure:

    for i in range(iterations):
        invoke_agent("red-team")    # appends to /test_cases/generated/
        invoke_agent("blue-team")   # edits /pipeline/
        invoke_agent("judge")       # writes /reports/run-*.json

        if converged_for_last_5_iterations():
            break

Each invocation spawns a fresh Claude Code session with the appropriate
AGENTS.md as its working context. The agents share only the filesystem;
they do not share state in memory.

Convergence: stop when the last 5 judge reports show overall score
improvement < --converge-threshold (default 0.02).

The first version of this script can use the Claude Agent SDK or
subprocess out to `claude-code --agent <name>`. The latter is simpler
to start with.
"""

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--converge-threshold", type=float, default=0.02)
    parser.add_argument("--skip-red", action="store_true",
                        help="judge + blue only, useful for early dev")
    args = parser.parse_args()

    print("STUB: orchestrator not implemented yet")
    print("Implementing this is the first task — see docstring in this file.")
    print(f"Would run {args.iterations} iterations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
