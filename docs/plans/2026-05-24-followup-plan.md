# Follow-up plan — 2026-05-24

Captures the two open TODOs and three audit-revealed prod gaps after the
session that landed PRs #1 and #2. Three suggested PRs (A, B, C) — each
independently shippable.

## Open items at session end

| ID | Title | Source |
|---|---|---|
| Task #68 | Make the "running" state on Run dashboard more prominent | User report, screenshot of `/run` showing only a tiny green dot |
| Task #69 | Surface per-iteration transparency for red/blue/judge agents | User report, "I want to see what each agent is trying / changing / scoring" |
| `Run.reconnect.test.tsx` | No reconnect indicator when websocket drops mid-loop | Audit row 7; test is `it.fails()` |
| `Authoring.modetab.test.tsx` ×2 | Mode-tab switch silently drops in-flight drafts | Audit row 8; both tests are `it.fails()` |
| `Settings.test.tsx` cross-section persistence | Sidebar nav drops typed-but-unsaved field values | Audit row 11; test is `it.fails()` |

---

## PR A — Prominent running indicator + close 4 audit-red tests

**Effort:** ~250 LOC, half a day.

**Closes:** Task #68 + all 4 `it.fails()` audit-red tests.

### A1. Run dashboard prominent banner (`ui/frontend/src/routes/Run.tsx`)

- Replace the small status pill in `RunControls` with a full-width header
  banner that's only rendered when `running:true`:
  - `bg-emerald-50 border-b border-emerald-300 text-emerald-900`
  - Pulsing dot (Tailwind `animate-pulse`) + `"Loop running — iteration N
    of M • elapsed Xm Ys"` + Stop button right-aligned
- Add a `useEffect` that mutates `document.title` to `"▶ Bratan — Iter N"`
  while running, cleans up on unmount or stop
- Add a SECOND conditional banner: when `running:true && !streamConnected`,
  show a yellow strip — `"⚠ Loop running, live feed disconnected —
  reconnecting…"` — this closes the failing `Run.reconnect.test.tsx`

### A2. Authoring mode-tab draft preservation

The root cause: each wizard (`CaseWizard`, `CaseWizardFromCorpus`) holds
draft state in its own `useState`. Switching tabs unmounts the inactive
one, dropping the state.

Two viable fixes — recommend the first:
- **Hoist draft state into `Authoring.tsx`** parent component. Pass
  down via prop + setter. Survives tab switches.
- **Zustand store** for cross-mount draft persistence. More machinery
  than needed for a single shared object.

Files: `ui/frontend/src/routes/Authoring.tsx`, plus signature changes
in the two wizards.

### A3. Settings cross-section persistence

Root cause: `Settings.tsx` swaps `ActiveSection` on sidebar click, step
components unmount, `useAutoSaveStep`'s 500ms debounce is cleared before
firing.

Recommend: add **flush-on-unmount** to `useAutoSaveStep` — on cleanup,
if a timer is pending, fire the save synchronously. Lower-blast-radius
than restructuring `Settings.tsx`.

Alternative: keep all sections mounted, use `display:none` to hide
inactive. Heavier (every section's queries fire on mount) but completely
sidesteps the unmount issue.

### A4. Test changes

- Flip `Run.reconnect.test.tsx` → `it()` (regression guard)
- Flip both `Authoring.modetab.test.tsx` tests → `it()`
- Flip `Settings.test.tsx` cross-section persistence → `it()`
- New `Run.runningBanner.test.tsx`: assert banner visible when
  `running:true`, absent when false
- New jsdom test for `document.title` mutation

---

## PR B — Per-iteration transparency, Phase 1 (surface what's on disk)

**Effort:** ~700 LOC, 1-2 days.

**Closes:** Task #69 surface layer. Does NOT yet require agent-prompt
changes — works with current free-form agent outputs.

### B1. Backend endpoints (`ui/backend/app.py` + schemas)

```
GET /api/reports/{ts}/red    →
  { generated_cases: [...],       # from test_cases/generated/<ts>.jsonl
    raw_log: "..." }              # from reports/history/agents/red-<ts>.log

GET /api/reports/{ts}/blue   →
  { changelog_entry: "...",       # parsed from pipeline/CHANGELOG.md by ts
    pipeline_diff: "...",         # `git diff <prev-ts>..<ts> pipeline/`
    commit_sha: "...",
    files_changed: ["..."] }

GET /api/reports/{ts}/judge  →
  { per_case_verdicts: [...],     # from reports/run-<ts>.json
    regressions: [...],           # vs previous report
    recoveries: [...],
    low_confidence: [...],
    drift_signal: {...} }
```

All three read what's already on disk — no agent-prompt changes
required.

### B2. Frontend route `/run/iterations/:ts`

- Three collapsible sections with the right emoji + agent role
- Mini-timeline at top: chips per iteration, current one highlighted,
  prev/next arrows
- Linked from each data point on the existing `Composite over time`
  chart — `onClick={() => navigate('/run/iterations/' + ts)}`

### B3. Tests

- 3 backend endpoint tests (one per endpoint) using existing
  `TestClient(app)` pattern
- Frontend route test for navigation + render
- Cross-query test: fixture data on disk → API returns it → UI shows
  it (audit-style `observable-outcome` pattern)

---

## PR C — Per-iteration transparency, Phase 2 (structured outputs + polish)

**Effort:** ~310 LOC, 2-3 days.

**Closes:** Task #69 fully.

### C1. Structured agent outputs

Update `agents/red-team/AGENTS.md` and `agents/blue-team/AGENTS.md` to
require the agent to emit a structured JSON block per iteration:

- Red team: `{intent, target_failure_category, hypothesis,
   accepted_count, rejected_count}`
- Blue team: `{hypothesis, change_summary, expected_lift_on,
   files_changed}`

Parser in `pipeline/agent_runner.py` extracts these structured fields
from the raw subprocess output.

### C2. Diff viewer

Lightweight syntax-highlighted before/after for the blue-team pipeline
diff. Use Prism (small) not Monaco (heavy).

### C3. Drift visualization (judge tab)

Mini timeline of drift signal across last N iterations + flag any
prejudge↔oracle disagreement spikes.

### C4. Tests

- Audit-style coverage matrix for the iteration detail surface
- Observable-outcome tests asserting structured fields render correctly
- Real-error path: malformed structured output → UI shows raw log
  fallback, doesn't crash

---

## Suggested order

| PR | Closes | LOC | When |
|---|---|---|---|
| **A** | Task #68 + 4 audit-red `it.fails()` | ~250 | Quick win, do first |
| **B** | Task #69 surface layer | ~700 | Bigger but high-impact |
| **C** | Task #69 full + agent-prompt structured outputs | ~310 | Optional polish; defer if PRs A+B already satisfy the user |

Total: **~1,260 LOC across 3 PRs.**

---

## Skills referenced (already in `docs/build-skills/`)

When implementing these PRs, apply:
- [`api-rewrite-sweep`](../build-skills/api-rewrite-sweep/SKILL.md) — every
  PR here changes component APIs; sweep consumer tests in the same commit
- [`observable-outcome-tests-over-mocks`](../build-skills/observable-outcome-tests-over-mocks/SKILL.md)
  — PR B's iteration detail page should drive the same code path the
  user drives, not mock the API layer
- [`ci-vs-dev-environment-parity`](../build-skills/ci-vs-dev-environment-parity/SKILL.md)
  — run `CI=true npx playwright test` locally before pushing
- [`fix-first-then-test`](../build-skills/fix-first-then-test/SKILL.md) —
  land every fix before re-running the harness; don't use the harness
  as a debugger
- [`pre-handoff-clean-state-proof`](../build-skills/pre-handoff-clean-state-proof/SKILL.md)
  — the 11-item checklist before claiming "ready, retest"
