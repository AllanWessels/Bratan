---
name: agent-model-selection
description: Pass model explicitly when dispatching sub-agents. Parent-default inheritance bypasses cost considerations; reserve stronger models for tasks that genuinely need them.
metadata:
  tags: [process, agents, cost, model-selection]
---

# Agent Model Selection

## When to use

- Any time you dispatch a sub-agent via the Agent tool.
- When the task mix includes both high-reasoning (architecture review, complex
  debugging) and low-reasoning (run a test suite, apply a grep, format a file) work.

## When NOT to use

- You are the sub-agent (model selection is for the dispatcher).

## How to apply

Pass `model:` explicitly in every Agent tool call. Do not rely on inheritance
from the parent session:

```
model: "sonnet"    # fast, cheap — use for: test runs, file reads, curl checks,
                   # mechanical code changes, grep-and-report tasks

model: "opus"      # slow, expensive — use for: architecture review, deep
                   # reasoning over a large codebase, novel algorithm design,
                   # judge agent (when correctness is load-bearing)
```

### Decision table

| Task type | Model |
|---|---|
| Run pytest / vitest / Playwright and report results | sonnet |
| Apply a targeted code fix from a spec | sonnet |
| Execute a pre-handoff checklist (curl + ls) | sonnet |
| Audit a test suite for structural gaps | sonnet |
| Design a new subsystem architecture | opus |
| Deep code review over 10+ files | opus |
| Judge / evaluator agent (correctness is load-bearing) | opus or sonnet pinned |
| Multi-file refactor from a spec | sonnet |

### The judge exception

If the model is acting as a stable evaluator / judge whose output is trusted
as ground truth (e.g. a RAG judge agent), do not downgrade it mid-run for
cost reasons. Inconsistent judge model = inconsistent scores = the optimization
loop optimizes noise. Pin the judge model in config and enforce it.

## Why this works

Sub-agents inherit the parent session's default model unless overridden. In a
session where the parent is using a strong model for architecture work, every
dispatched sub-agent (including "just run `ls` and report back") also runs on
that model. At scale — dozens of parallel verification agents — this cost
multiplies significantly. Explicit selection ensures each agent uses the
minimum capable model for its task.

## Anti-patterns to avoid

- **Omitting `model:` and assuming inheritance is intentional** — it is
  accidental. Always be explicit.
- **Downgrading a judge or evaluator agent to save cost** — the judge's
  reliability is a system invariant, not an optimization target.
- **Using a strong model for a mechanical task "just to be safe"** — this
  is false safety. A test runner either passes or fails; a stronger model
  does not change the test results.

## Cross-links

- [[parallel-fanout-verification]] — where most sub-agent dispatches happen;
  all test-runner agents should use sonnet
