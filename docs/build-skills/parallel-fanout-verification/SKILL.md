---
name: parallel-fanout-verification
description: When verifying or fixing a multi-layer change, dispatch each test layer and each independent fix as a parallel sub-agent rather than running serially in the main context.
metadata:
  tags: [process, testing, parallelism, agents]
---

# Parallel Fanout Verification

## When to use

- A change touches more than one layer (backend + frontend + E2E + live integration).
- You have two or more independent bugs to fix on the same branch.
- Any verification task would produce log spam (torch, chromadb, vite, huggingface)
  large enough to crowd out useful context.
- You are about to run pytest, vitest, and Playwright sequentially in the main thread.

## When NOT to use

- The task is a single, trivial, self-contained change (one file, one assertion).
- You genuinely need the output of step N before you can begin step N+1
  (sequential dependency — rare, but real).
- You are already inside a sub-agent dispatched from a parent — nesting deep
  fanouts without coordination creates race conditions on shared files.

## How to apply

### Fanning out test layers

Dispatch one Agent-tool call per test suite, all with `run_in_background: true`:

```
Agent 1: "Run pytest tests/ -q. Report: count passed/failed, first 10 lines
          of any failure. ≤250 words."
Agent 2: "cd ui/frontend && npm test -- --run. Same format."
Agent 3: "npx playwright test. Same format."
Agent 4: "Live integration: hit /api/health, /api/corpus/search (empty corpus),
          /api/setup/state. Report HTTP status codes only."
```

Continue with other work while all four run. Merge their reports when
notifications arrive — don't tail transcript files (that overflows context).

### Fanning out fixes

Carve lanes by file ownership so agents don't conflict:

| Agent   | Owns                                      |
|---------|-------------------------------------------|
| Agent A | `backend/**`, `tests/**`                  |
| Agent B | `ui/frontend/src/**`, `*.test.tsx`        |
| Agent C | `e2e/**`, Playwright helpers              |

One agent per logical bug. Brief each agent with: the bug description, the
files it owns, and "commit when done — one atomic commit with a why-first
message."

The parent collects completion notifications, then fans out a single
verification pass over all three branches (see [[pre-handoff-clean-state-proof]]).

### The "fix agent AND verifier agent" pattern

When you are not certain a fix will work, dispatch the fix agent AND a verifier
agent simultaneously. The verifier checks the live system as it stands; the fix
agent lands the change. If the verifier reports failure AFTER the fix lands,
that's a regression — GOTO [[fix-first-then-test]].

## Why this works

The main conversation context is finite. Multi-minute test suites produce
thousands of lines of log output (framework startup, deprecation warnings, test
summaries). Running them inline burns context that cannot be recovered and
serializes work that could complete in parallel. Dispatching agents keeps the
main thread free for reasoning while the harness runs.

## Anti-patterns to avoid

- **"I'll just run one test suite inline to check"** — this is how log spam
  kills sessions. Always dispatch, even for a single-suite run.
- **Overlapping file ownership** — two agents editing the same file creates
  merge conflicts on shared state. Define lanes before dispatching.
- **Forgetting to wait for all notifications** — claiming the fix is complete
  after only some agents have reported. Every agent must report before handoff.
- **Tailing transcript files** — the system warning is real; transcripts overflow
  context. Read the notification summary instead.

## Cross-links

- [[fix-first-then-test]] — fanout is for verification, not for discovering bugs
- [[pre-handoff-clean-state-proof]] — the final gate before handing back to the user
- [[agent-model-selection]] — pass `model:` explicitly when dispatching agents
