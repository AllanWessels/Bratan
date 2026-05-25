---
name: audit-then-fanout-fix
description: When a class of bug keeps slipping through tests, run a coverage-matrix audit first, then fan out fix agents per gap — don't whack-a-mole individual failures.
metadata:
  tags: [process, testing, audit, systematic]
---

# Audit Then Fanout Fix

## When to use

- The same class of bug has appeared more than once (stale state, missing
  empty-state assertions, cross-component invalidation, form gating).
- A user reports multiple related bugs in one session ("the wizard values
  aren't persisting", "VRAM math ignores toggles", "sliders map to wrong fields").
- A test suite shows a pattern of passing tests next to user-reported failures.
- You are about to write a one-off fix for the third bug in the same category.

## When NOT to use

- The bug is isolated, novel, and clearly unrelated to any prior failure.
- The codebase has no test suite — an audit produces a gap list, but there
  is no comparison baseline.
- The audit itself would take longer than just fixing all the known bugs
  (small, well-bounded codebase with fewer than ~5 components).

## How to apply

### Step 1: Build the coverage matrix

For each interactive component × user-action × observable-outcome triple,
determine whether a test covers the *observable outcome* (not just the action).

```
Component          | User action              | Observable outcome          | Covered?
-------------------|--------------------------|----------------------------|----------
CorpusBrowser      | Click "Ingest"           | Row badge → "42 chunks"    | NO (mutate only)
CaseWizard         | Land without anchor      | Empty-state placeholder    | NO (absent DOM only)
Step6GPU           | Toggle use_local=false   | VRAM row disappears        | NO (render-only)
Step8Weights       | Drag correctness slider  | Only correctness field set | NO (payload checked once)
```

Categorize each gap by class:

| Class | Description |
|---|---|
| **cross-query** | Component A mutates; component B should re-render via shared cache |
| **state-transition** | Before-action state is asserted but not the transition itself |
| **observable-persistence** | Mutation succeeds but list/display doesn't reflect it |
| **real-error-path** | Only the happy path is covered; error responses not simulated |
| **cross-tab / cross-route** | State must survive navigation or mode switch |
| **form-gating** | Submit/next button gating logic is not tied to field validation |

### Step 2: Prioritize by user-impact × likelihood

Score each gap:

- **user-impact**: 3 = user-facing visible bug, 2 = incorrect but hidden, 1 = edge case
- **likelihood**: 3 = reproduces deterministically, 2 = reproduces with specific config, 1 = rare

Prioritize 3×3 and 3×2 gaps first. 1×1 gaps go on the backlog.

### Step 3: Fan out fix agents by class

Group gaps by class, assign one agent per class:

```
Agent A (cross-query gaps):
  - Add QueryClient integration helper with real QueryClient + stubbed http
  - Rewrite CorpusBrowser.actuation.test to assert chunk count after ingest
  - Rewrite ValidationPanel.actuation.test to assert cross-hook state

Agent B (observable-persistence gaps):
  - Add pre-anchor empty-state assertions to CaseWizardFromCorpus.actuation.test
  - Add post-ingest badge assertion to CorpusBrowser.actuation.test

Agent C (cross-route Playwright specs):
  - wizard-toggle-cascade.spec.ts: Step3 toggles → Step6 VRAM rows
  - authoring-mode-switch.spec.ts: mode switch preserves / clears draft
```

File ownership per agent (see [[parallel-fanout-verification]] for lane rules):
- Agent A owns `*.actuation.test.tsx` files for cross-query components.
- Agent B owns `*.actuation.test.tsx` files for persistence components.
- Agent C owns `e2e/*.spec.ts` files.

### Step 4: Verify the matrix is closed after all agents report

Re-run the coverage matrix after fixes land. Every cell that was "NO" must
be "YES" before the session is considered done.

### The audit document format

Produce a compact markdown table (save to `docs/test-audit-<date>.md`):

```markdown
# Test audit — <date>

## Coverage matrix

| Component | Action | Observable outcome | Class | Priority | Test added |
|---|---|---|---|---|---|
| CorpusBrowser | Ingest click | Chunk count badge | observable-persistence | 3×3 | CorpusBrowser.actuation l.89 |
...

## Summary counts

- Gaps found: N
- Unit fixes: N
- Playwright fixes: N
- Gaps deferred: N (with rationale)
```

## Why this works

Whack-a-mole fixing responds to each bug report independently, producing N
targeted fixes that share no common structure. The next developer (or the
next session) faces the same gap list in a different guise. An audit pass
names the *class* of gap, which enables:

1. A fix that closes the entire class (e.g. "add pre-anchor state assertions
   to every wizard-like component") rather than the specific instance.
2. A checklist that prevents the class from recurring (e.g. "every new
   component gets an empty-state assertion").
3. Efficient parallelism — fix agents can be dispatched per class rather than
   per bug.

## Anti-patterns to avoid

- **Skipping the matrix and going straight to fixes** — you will miss the
  other bugs in the same class that haven't been reported yet.
- **Classifying gaps as "nice to have"** — every gap in the matrix was a
  user-reported bug at some point. If it could have been reported, it will
  be reported again.
- **Audit without fanout** — the audit is worthless if it produces a list
  that sits in a doc. The fanout is what closes the gaps.
- **One agent for all gaps** — serial execution on a shared file set creates
  conflicts and burns context. One agent per class.

## Cross-links

- [[observable-outcome-tests-over-mocks]] — the testing technique that fills
  the gaps the audit identifies
- [[parallel-fanout-verification]] — how to dispatch the fix agents
- [[fix-first-then-test]] — fix all gaps before re-running the harness
