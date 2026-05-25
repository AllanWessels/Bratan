# Build Skills

These are the **meta-skills** the assistant used to BUILD this project —
portable, project-agnostic process techniques for collaborating on hard
codebases. They are distinct from `/skills/` (RAG domain techniques the
pipeline agents use at runtime).

> **Live source-of-truth:** `~/.claude/skills/`  
> This directory is a snapshot for project visibility and for linking from
> the repo README. If the two copies ever diverge, `~/.claude/skills/` wins.

## Skills

| Skill | One-line description |
|---|---|
| [parallel-fanout-verification](parallel-fanout-verification/SKILL.md) | Dispatch each test layer and each independent fix as a parallel sub-agent; never run suites serially in the main context. |
| [fix-first-then-test](fix-first-then-test/SKILL.md) | Land every fix before running the harness; use grep + read to debug, reserve the harness for verification. |
| [verifier-state-vs-user-state](verifier-state-vs-user-state/SKILL.md) | End every verifier run with process-level restart + round-trip health check — disk wipe alone doesn't clear in-memory singleton clients. |
| [subprocess-isolation-for-process-state-clients](subprocess-isolation-for-process-state-clients/SKILL.md) | Wrap both read and write paths through singleton-state clients (chromadb, sqlite-WAL) in subprocess workers so disk changes are always reflected. |
| [observable-outcome-tests-over-mocks](observable-outcome-tests-over-mocks/SKILL.md) | Tests that mock the bug layer can't catch bugs there; assert visible state transitions, not call counts or absent DOM nodes. |
| [pre-handoff-clean-state-proof](pre-handoff-clean-state-proof/SKILL.md) | Before "ready, retest" — prove clean state with a concrete numbered checklist of real commands with expected outputs. |
| [audit-then-fanout-fix](audit-then-fanout-fix/SKILL.md) | When a bug class recurs, run a coverage-matrix audit first, then fan out one fix agent per gap class — don't whack-a-mole. |
| [agent-model-selection](agent-model-selection/SKILL.md) | Pass `model:` explicitly when dispatching sub-agents; default inheritance is accidental and expensive at scale. |
| [api-rewrite-sweep](api-rewrite-sweep/SKILL.md) | The commit that changes a component's public API must sweep every consumer test in the same commit — split commits leave CI broken even when each commit is internally consistent. |
| [ci-vs-dev-environment-parity](ci-vs-dev-environment-parity/SKILL.md) | Before pushing to CI, validate local runs are representative — three predictable axes diverge: gitignored fixtures, dev-only ports, dev-only env vars. |
