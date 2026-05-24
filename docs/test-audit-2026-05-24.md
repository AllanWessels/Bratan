# Test audit — 2026-05-24

## Headline

**The `*.actuation.test.tsx` suite exercises every interactive element in isolation
but does not assert what the user actually sees.** Tests check `expect(textarea).not
.toBeInTheDocument()` before a passage is anchored — they do *not* check that the
section *labelled* "2. Write the question and answer" no longer claims to be a
writing surface. Every reported bug in the user's list (textareas not editable,
wizard values not persisting, VRAM math ignoring toggles, vLLM section confusing,
sliders mis-mapped, Chroma "tenants" error) is a **cross-component or visible-state-
versus-DOM-state** divergence that unit-level actuation tests structurally cannot
catch.

## Findings by file

Class key:
1. Render-only (mount + element-present, no click→re-render cycle)
2. Isolated-input (typing into a control that's "in test scope" but never
   verified against the surrounding enabled/disabled gate)
3. Mocked-too-much (mocks the very hook the test should be exercising)
4. No-assertion-after-action (fires a click, never waits for the consequent UI change)
5. Happy-path-only (success branch only, no disabled/error/loading branch)

### Authoring suite

- `CaseWizardFromCorpus.actuation.test.tsx` — **class 5 gap**. The test asserts
  the textarea is absent before anchoring and present after. It never asserts
  the empty-state copy ("Click a passage above to start writing your case")
  is visible, nor that the misleading section title "2. Write the question and
  answer" is *not* shown without explanatory context. The user reported the bug
  precisely because the *label* "Write the question and answer" is what they
  see — the test would pass even if the empty-state placeholder said the wrong
  thing. (Lines 151–189: pre-anchor block tests `.queryByLabelText` only.)
- `CaseWizardFromCorpus.actuation.test.tsx` — **class 3 gap**. Every hook
  (`useSaveDraft`, `useSeedSave`, `useSeedValidate`, `useCorpusFiles`,
  `useCorpusPassagesPaginated`) is `vi.hoisted` and mocked. The actual
  network shape (e.g. paginated 404, empty file list) is never exercised; only
  the cooperative case is.
- `CaseWizard.actuation.test.tsx` — **class 5 gap**. No test for the
  question-first wizard's "no passages selected yet → Save disabled with
  helpful tooltip" path; the "Save is disabled when no category" test (l.155)
  only proves the disabled bit, not that the user can recover from the state.
- `CorpusBrowser.actuation.test.tsx` — **class 4 gap**. Tests fire
  `startIngest.mutate` and assert call count, but never assert the
  post-ingest UI (the chunk count badge, the row going from `not ingested`
  amber → `n chunks` green). The mutation→re-render→list-refresh cycle is
  absent.
- `PassagePicker.actuation.test.tsx` — clean. Properly drives expand /
  collapse / add / remove. **No gap.**
- `ValidationPanel.actuation.test.tsx` — **class 5 gap**. Toggle on/off is
  covered. The `isLoading=true` + `isError=true` rendering of the panel
  alongside the toggle is not.

### Setup wizard suite (Step1–Step8)

All eight `Step*.actuation.test.tsx` files share the same shape: mock fetch,
fire user interactions, wait `~700ms`, snapshot `captured` and assert the
**payload sent to `/api/setup/save-step` matches the typed value**. This is
good wire-shape coverage but four common gaps remain:

- `Step2VectorDB.actuation.test.tsx` — **class 1 + class 5**. Tests verify
  Qdrant/Pinecone/Weaviate/pgvector/other text inputs feed into the autosave
  payload, but every connection-test call is mocked to `ok: true`. The Chroma
  "tenants" error the user reported (chroma's "the tenant does not exist"
  500-response from a misconfigured chroma_collection) is never simulated.
  No test asserts what happens when `/api/setup/test-vectordb` returns
  `ok: false` with an arbitrary `error` blob — the `e2e/error-recovery.spec.ts`
  covers Qdrant happy-path failure only.
- `Step3Models.actuation.test.tsx` — **class 2 + class 5**. Verifies typing
  into `oracle_model`, `prejudge_model`, `embedding_model`, `reranker_model`
  is autosaved. Does NOT verify: (a) the managed-vLLM lifecycle (start →
  ready → auto-Test → toast), (b) the `use_local_prejudge=false` path that
  HIDES the vLLM section entirely, (c) the cross-component interaction where
  toggling local-embedding=OFF should remove the embedding row from Step 6's
  VRAM breakdown.
- `Step4Costs.actuation.test.tsx` — **class 1**. Inputs and autosave verified,
  but no test asserts the "USD per run < tokens × token-price" UX warning
  (if any). Costs are tested as input ports, not as a coherent UI.
- `Step5SeedTarget.actuation.test.tsx` — clean. Slider drag → payload, plus
  clamp tests. **No gap.**
- `Step6GPU.actuation.test.tsx` — **class 5**. Probe button click → mutate
  is covered. The **user's "VRAM math ignored toggles" bug** is precisely
  here: the VRAM breakdown depends on `config?.models.use_local_*` flags,
  which depend on Step 3's state. **No test renders Step6GPU with a config
  whose `use_local_embedding=false` and asserts the embedding row is
  excluded from the breakdown.** That cross-step interaction is the bug,
  and it's untested.
- `Step7Stopping.actuation.test.tsx` — clean wire-shape coverage. **No gap.**
- `Step8JudgeWeights.actuation.test.tsx` — **class 1**. Slider drag →
  autosave is verified, but the sum-to-1 banner is asserted on the
  *rendered text*, not on whether the wizard's **Next** button is disabled
  (it isn't — the user can advance with weights summing to 1.2). The
  user-reported "sliders mis-mapped to wrong component" bug would have
  been caught by an assertion that `data-testid="slider-correctness"`
  controls `judge_weights.correctness` and **only** that field.

### Routes

- `Run.actuation.test.tsx` — **class 5**. Every input + Start/Stop is
  driven. `useLoopStream` is mocked to `connected: true`. The disconnect
  case (`connected: false`, the user's "is it still running?" question)
  is never asserted.
- `Settings.actuation.test.tsx` — **class 1**. Sidebar navigation works.
  No test edits a value in any section and verifies the change *persists*
  across nav clicks (Project → Vector DB → back to Project).

## The CaseWizardFromCorpus specific gap

**User's flow:**
1. User lands on `/authoring`, sees the "From the corpus" tab is already active.
2. User clicks a file in the left rail → passages load.
3. User does NOT click a passage. They scroll down.
4. User sees the card titled **"2. Write the question and answer"** and the
   empty-state panel inside it (dashed-border placeholder).
5. User concludes "the boxes are broken — they should be editable."

**Test's flow** (`CaseWizardFromCorpus.actuation.test.tsx:151`):
1. Render the wizard.
2. Click a file.
3. Assert `screen.queryByLabelText(/^question/i)` is NOT in the DOM. **Pass.**

**Divergence:** the test asserts the *absence* of a hidden DOM node. The user
asserts the *presence* of a misleading card title. A passing test ≠ a passing
UX. The empty-state placeholder *exists* in the DOM (l.491–517 of
`CaseWizardFromCorpus.tsx` — wrapped in `<div data-testid="empty-state-no-anchor">`),
but no test asserts it is shown alongside its `MousePointerClick` icon and its
"locked until you anchor a passage" copy. Even if a future commit deleted the
empty-state and left only the disabled textareas, **the actuation test would
still pass.**

There IS a Playwright spec for this exact flow (`e2e/verify-from-corpus.spec.ts`)
and it is the right shape — it walks the real DOM, asserts the empty state is
visible, then asserts the textareas appear and are editable after a passage
click. But (a) it's marked as an "ad-hoc verifier" against a dev server on
port 5173, not the preview server on 4173; (b) it is therefore likely not
run by the default `npx playwright test` invocation; (c) it logs but doesn't
fail on a missing empty-state. The fix is to fold its assertions into
`e2e/seed-authoring.spec.ts` (which runs in CI).

## Recommendations

### Promote to Playwright

Cross-component / cross-route flows that cannot be tested at the unit level:

- **Step3 `use_local_*` toggle → Step6 VRAM breakdown**: requires navigating
  through the wizard, persisting Step 3, advancing to Step 6, asserting the
  breakdown row count. Unit tests would have to mock the entire `useConfig`
  hook AND `useProbe`, which then proves nothing.
- **Authoring mode tab switch → wizard reset**: clicking "From a question"
  after typing in "From the corpus" — does the from-corpus draft survive?
  Two components, two stores, one user expectation.
- **Wizard step persistence across reload**: the user-reported "values not
  persisting (wrapping)" bug. The `wizard.spec.ts` already covers this. Make
  sure every NEW step gets a step entry there. Right now Step 6 is
  intentionally skipped (no input), but Step 3 only tests `oracle_model` and
  `anthropic_api_key`, not the local-model toggles.
- **Corpus ingest → corpus browser refresh**: clicking "Ingest" should
  eventually show `n_chunks` on each file. The unit test only fires the
  mutation; the round-trip is a Playwright shape.
- **Authoring → seed.jsonl on disk**: `seed-authoring.spec.ts` covers this
  but bypasses the UI's Save button. Fix: make the validation-gate testable
  so the test can drive the actual button (currently it POSTs directly).

### Rewrite to test the full state machine

Where a unit test should drive transitions, not snapshots:

- `CaseWizardFromCorpus.actuation.test.tsx` — add a `pre-anchor visible state`
  describe block that asserts (a) the empty-state placeholder IS shown,
  (b) the "Highlight passage list" CTA is present, (c) the `[data-testid=
  "empty-state-no-anchor"]` is visible, (d) the **anchored-passage banner is
  NOT present**. Then click → assert all four flip.
- `Step6GPU.actuation.test.tsx` — add tests that mount with a config where
  `use_local_embedding: false` and assert `[data-testid="vram-row-embedding"]`
  is not in the DOM, and the total reflects only the remaining rows.
- `Step8JudgeWeights.actuation.test.tsx` — add tests that drag two sliders
  and assert (a) the *third* slider's data-percentage is unchanged, and
  (b) each slider's testid maps to the correct weight field via the autosave
  payload (not just via `data-testid`).
- `Settings.actuation.test.tsx` — add a test that types a project name,
  clicks Vector DB, clicks back to Project, and asserts the project name is
  still the typed value (state persistence across nav).

### Playwright spec template for new features

```ts
// e2e/<feature>.spec.ts — adopt for every new user-facing feature.
import { test, expect } from "@playwright/test";
import { resetBratanState } from "./helpers";

test.beforeEach(() => resetBratanState());

test("<feature> — happy path persists to disk", async ({ page }) => {
  await page.goto("/<route>");

  // 1. EMPTY-STATE assertion: what does the user see when they first land?
  await expect(page.getByTestId("<feature>-empty-state")).toBeVisible();

  // 2. PRIMARY ACTION: click the thing that drives the state forward.
  await page.getByRole("button", { name: /<primary cta>/i }).click();

  // 3. INTERMEDIATE state: assert the loading/spinner appears AND disappears.
  await expect(page.getByTestId("<feature>-loading")).toBeVisible();
  await expect(page.getByTestId("<feature>-loading")).toBeHidden();

  // 4. ENABLED state: the previously-locked controls now exist + are editable.
  const input = page.getByLabel(/<input label>/i);
  await expect(input).toBeEnabled();
  await input.fill("test value");
  await expect(input).toHaveValue("test value");

  // 5. PERSISTENCE: reload, then re-assert the value is preserved.
  await page.reload();
  await expect(page.getByLabel(/<input label>/i)).toHaveValue("test value");

  // 6. ERROR PATH: force a failure mode and assert humane copy (no raw JSON).
  // 7. RECOVERY: fix the failure and assert the error UX clears.
});
```

Every new feature commit should include one such file. The five-line empty-
state assertion at step 1 is the single biggest delta from current practice
— most existing tests skip directly to step 4.

## Concrete TODO list

Tests to add (component • file • state transition asserted):

1. **CaseWizardFromCorpus** • `CaseWizardFromCorpus.actuation.test.tsx` •
   pre-anchor empty-state IS visible AND `anchored-passage` banner IS NOT
   visible. Mirror of the existing l.151–189 block but flipped.
2. **CaseWizardFromCorpus** • same file • clicking the "Highlight passage
   list" CTA toggles `data-pulse="true"` on the passage list for ~1.5s then
   back to `false`. (Currently `Element.prototype.scrollIntoView` is mocked
   but the pulse flag transition isn't asserted.)
3. **Step6GPU** • `Step6GPU.actuation.test.tsx` • rendering with
   `use_local_embedding: false` excludes `[data-testid="vram-row-embedding"]`
   and reduces `[data-testid="vram-total-mb"]` by the embedding's MB.
4. **Step6GPU** • same file • toggling `use_local_prejudge: false` excludes
   the prejudge row even when the model name still matches a `VRAM_TABLE`
   entry. (Catches the user's "VRAM math ignored toggles" bug.)
5. **Step3Models** • `Step3Models.actuation.test.tsx` • setting
   `use_local_prejudge: false` HIDES the vLLM base-url + Test button entirely
   (catches "Step 3 vLLM section confusing"). If the section is meant to
   stay visible-but-disabled, assert THAT.
6. **Step2VectorDB** • `Step2VectorDB.actuation.test.tsx` • when
   `/api/setup/test-vectordb` returns `{ ok: false, error: "tenant does not
   exist" }`, the UI renders the verbatim error (no swallowing). Catches the
   user's Chroma tenants bug.
7. **Step8JudgeWeights** • `Step8JudgeWeights.actuation.test.tsx` • dragging
   correctness updates ONLY `judge_weights.correctness` in the payload (not
   `recall_at_5` nor `faithfulness`). Catches "sliders mis-mapped".
8. **SetupWizard** • `wizard.spec.ts` (Playwright) • extend Step 3 to drive
   all three `use_local_*` toggles AND `prejudge_model`/`embedding_model`/
   `reranker_model`, then read `bratan.config.yaml` and assert each field.
   Catches the wrapping/persistence bug at the level the user feels it.
9. **Authoring** • new `Authoring.actuation.test.tsx` • switching mode tab
   from "From the corpus" to "From a question" mid-draft preserves the
   user's typed question (or, if not preserved, surfaces a confirm dialog).
10. **CorpusBrowser** • `CorpusBrowser.actuation.test.tsx` • after a
    `state: "succeeded"` ingest-status mock, the file row's
    `not ingested` amber badge flips to `{n} chunks` text.
11. **ValidationPanel** • `ValidationPanel.actuation.test.tsx` • with
    `isLoading=true`, the toggle is still rendered (asserts the loading
    spinner doesn't steal the toggle's DOM slot).
12. **Run** • `Run.actuation.test.tsx` • with `useLoopStream` returning
    `connected: false` AND `useLoopStatus` returning `running: true`, the
    UI surfaces a reconnect / "connection lost" indicator (catches the user's
    "is it still running?" gap).
13. **e2e** • fold `verify-from-corpus.spec.ts` into `seed-authoring.spec.ts`
    so the CI suite covers the "boxes are editable after anchoring" flow at
    the level the user reported. Drop the dev-server-only verifier.
14. **e2e** • new `wizard-toggle-cascade.spec.ts` — drive Step 3 toggles to
    false, advance to Step 6, assert the VRAM breakdown contains no rows for
    the toggled-off components.
15. **e2e** • new `authoring-mode-switch.spec.ts` — drive both authoring
    modes, switch between them, assert per-mode state isolation (or shared
    state, whichever is the intended design).

**Count: 12 unit tests + 3 Playwright specs = 15 new tests.**

These are the minimal set to cover the six user-reported bugs. The systemic
fix — adopting the Playwright spec template at the top of this section for
every new feature — is the part that keeps these classes of bug from
recurring once the backlog is cleared.
