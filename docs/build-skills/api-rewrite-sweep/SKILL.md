---
name: api-rewrite-sweep
description: When a commit changes a component's public API, the same commit must update every test asserting the removed surface — split commits leave CI broken even when each commit is internally consistent.
metadata:
  tags: [process, testing, refactoring, api, discipline]
---

# API Rewrite Sweep

## When to use

- You are rewriting a component and changing its public contract: renamed props,
  removed or renamed DOM attributes, changed label copy, redesigned state
  machines, restructured return shape of a hook.
- A commit renames or removes a symbol that tests or specs reference by name.
- A behavioral change flips the meaning of an assertion (e.g. a button that
  was disabled is now enabled).
- You are about to push a refactor and want to validate that the intermediate
  commit state doesn't break CI.

## When NOT to use

- The change is purely internal (implementation detail, no exported surface
  altered). Grep sweeps are still cheap but optional.
- The rename is to a private / unexported name with no test coverage. Confirm
  with a grep; if nothing matches, move on.

## How to apply

### Before committing an API-change

1. **Enumerate every removed or renamed symbol** — attributes, label strings,
   prop names, hook return keys. Write them down; you will grep for each one.

2. **Sweep unit tests.**
   ```bash
   grep -rn 'data-valid\|old-prop-name\|"Save disabled"' src/ tests/
   ```
   Every hit that asserts the old surface gets updated in this commit.

3. **Sweep e2e specs separately.** Playwright specs live in `e2e/` (or
   `playwright/`), not under `tests/`, and are easy to miss with a `tests/`-
   scoped grep.
   ```bash
   grep -rn 'data-valid\|"Save disabled"' e2e/ playwright/
   ```

4. **Check for behavioral inversions.** If a button changed from disabled to
   enabled, `grep 'disabled'` won't help — the symbol is the same, the
   semantic flipped. Ask: *what was the old behavior shape?* Then grep for
   tests asserting that shape by intent (e.g. `canSave.*false`,
   `expect.*toBeDisabled`).

5. **Either fix every hit in the same commit, or explicitly note it in the
   commit body as a follow-up** — but be honest: a follow-up that hasn't
   landed yet is a broken CI state in the branch. Prefer fixing it now.

### Grep cheatsheet

| What changed | Grep target |
|---|---|
| DOM attribute `data-valid` → `data-difficulty` | `data-valid` in test dirs |
| Label text "Passages retrievable" → "Pipeline retrieves" | the old string literal |
| Prop `isValid` removed | `isValid` in test files |
| `canSave` gate changed | `canSave` + `toBeDisabled` + `toBeEnabled` |
| Hook return key `results` → `hits` | `\.results` and destructures |

### What counts as "updated"

- Assertions that referenced the old symbol now reference the new one.
- Tests that assumed the old behavior shape (e.g. button was disabled) are
  rewritten for the new shape or explicitly removed with a comment explaining
  why the behavior no longer exists.
- Skipped tests (`test.skip`) are acceptable as a short-lived escape hatch
  if behavior is still being designed — but the skip message must name the
  tracking issue or commit.

## Why this works

The invariant is: **the commit that breaks the contract is the commit that
fixes its consumers.** Splitting the work across commits leaves the
intermediate state broken in CI even when each individual commit is internally
consistent. CI runs the full suite at every commit; there is no "just a
transition state" from CI's perspective.

When the rewrite and the consumer fixes land together, the tree is always
green. When they are split, CI is red between them — and that red state is
indistinguishable from a real bug to the next person who pulls the branch.

## Anti-patterns to avoid

- **"I'll update the tests in the next commit"** — that next commit may never
  come, and CI catches the gap immediately. The split always looks intentional
  in hindsight; it rarely is.
- **Relying on grep alone for behavioral changes.** A button that went from
  disabled to enabled has the same symbol in the before and after; grep won't
  surface the test that asserts `toBeDisabled`. Read the old test logic, not
  just the old symbol.
- **Trusting "I ran the tests locally" without checking the test count.** A
  silently-skipped test suite passes locally and fails nowhere — until CI
  runs a stricter config. Check that the number of tests that ran matches
  what existed before the rewrite.
- **Updating only the unit tests and forgetting the Playwright specs.** E2e
  specs often assert the most visible part of a component's surface (the
  label text, the attribute used as a selector) and are the first to break.

## Cross-links

- [[fix-first-then-test]] — the rewrite is a "fix"; sweep the consumers
  before the harness tells you they broke
- [[observable-outcome-tests-over-mocks]] — consumer tests that mocked the
  removed layer won't catch the breakage; observable-outcome tests will
