---
name: fix-first-then-test
description: Land every code fix before running the test harness. Use grep + read to debug; the harness is a verifier, not a debugger.
metadata:
  tags: [process, testing, debugging, discipline]
---

# Fix First, Then Test

## When to use

- You are tempted to run a failing test suite to "see what breaks."
- You have a bug report and are about to start the harness before reading
  the relevant code.
- Multiple bugs are known to exist simultaneously — you have a list.
- A prior harness run reported a failure and you are deciding what to do next.

## When NOT to use

- You genuinely do not know where the bug is and have exhausted grep/read
  strategies. In that case, a single targeted test (not the full harness) to
  confirm a hypothesis is acceptable — but dispatch it as a sub-agent
  (see [[parallel-fanout-verification]]) so it doesn't burn inline context.
- The "fix" is a configuration change or flag flip with no code to read first.

## How to apply

### The invariant order

1. **Reproduce in your head from the code.** Read the relevant files. Use grep
   to trace the call path. Identify the exact line(s) responsible.
   Do NOT start the harness before completing this step.

2. **Fix all known bugs for a logical unit.** If three bugs share a root cause,
   fix all three together. If three bugs are independent, dispatch three fix
   agents in parallel (see [[parallel-fanout-verification]]).
   Each fix gets one atomic commit with a why-first message.

3. **Run the harness after all in-flight fixes are committed.** Fan out:
   pytest + vitest + Playwright + live integration, all in parallel sub-agents.
   Never run them one-by-one.

4. **Act on harness reports.** A new failure = GOTO step 1, not "let's see
   if another run clears it."

### Debugging tools (use these instead of the harness)

| Goal | Tool |
|------|------|
| Find where a variable is set | grep -r "varname" src/ |
| Trace a call path | Read the call site, then the callee, then its deps |
| Confirm a hypothesis about state | Read the relevant state store / hook |
| Understand a component's render conditions | Read the component's return, not the test |

### Classifying a harness failure

When a harness run reports failures:

- **Failure you already knew about** — don't re-run. Fix it first.
- **Failure that reveals a new bug** — stop. Reproduce from code. Fix. Then
  re-run the full harness.
- **Flaky failure (same code, different result on re-run)** — this is a
  test-infrastructure problem. Investigate the test, not the product code.

## Why this works

The test harness is optimized for breadth: it runs every case, produces
complete output, and terminates. It is not optimized for locality: the failure
message points at what broke, not why. Using the harness as the first step of
debugging forces you to read failure output, form a hypothesis, and THEN read
the code — which is the same work you would have done by reading the code
first, but with thousands of lines of noise in between. Reading the code first
is faster and preserves context.

## Anti-patterns to avoid

- **"Let's see what the tests say"** — this is the failure mode this skill
  exists to prevent. If you catch yourself saying this, stop and read the code.
- **Fixing one bug then immediately re-running the full suite** — wastes a run
  if other known bugs remain. Batch fixes before running.
- **Using test output as the only source of truth about what the code does** —
  tests describe intended behavior, not actual behavior. The code is the
  ground truth.
- **Claiming a bug is "hard to reproduce locally" as a reason to skip step 1** —
  if you can read the code, you can reproduce it in your head. "Hard to
  reproduce" is about test infrastructure, not about whether reading the code
  is useful.

## Cross-links

- [[parallel-fanout-verification]] — how to run the harness efficiently once
  fixes are ready
- [[observable-outcome-tests-over-mocks]] — why some harness failures reveal
  nothing about the real bug
