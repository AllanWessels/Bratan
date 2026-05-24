# UI coverage audit — 2026-05-24

Companion to `test-audit-2026-05-24.md`. That doc cataloged what the
`*.actuation.test.tsx` files miss; this doc inventories the whole frontend
surface — every route, every component, every user action — and pins each
(component × action × observable outcome) triple to a test or marks it
**GAP**.

The trigger was the ingest-toast bug: `useIngestStatus` invalidates
`["corpus-files"]` on `state === "succeeded"`, but `CorpusBrowser.actuation
.test.tsx` mocks both hooks as independent puppets, so the cross-query
coupling is invisible. The class of bug is "two queries in the same
component must coordinate, and the test mocks them apart" — and once
that's the lens, the same class shows up in Step 3↔Step 6, Authoring's
two ingest call-sites, the seed-list progress bar, and more.

---

## Section 1 — Inventory

### 1A — Routes

| Route path | File | Purpose |
|---|---|---|
| `/` | `src/App.tsx::HomeRedirect` | Redirects based on `useSetupState`: incomplete → `/setup/<n>`, complete → `/authoring`, error → `/setup`. |
| `/setup`, `/setup/:step` | `src/routes/SetupWizard.tsx` | 8-step wizard host. Renders sidebar `StepIndicator`, Next/Previous/Skip controls, and the active step component. |
| `/authoring` | `src/routes/Authoring.tsx` | Mode-tabbed authoring host (`from-corpus` default, `from-question` legacy). Renders progress bar, target-reached banner, mode tabs, then the active wizard. |
| `/run` | `src/routes/Run.tsx` | Live run dashboard. TopBar metrics, composite/per-category/cost/drift charts, regression table, RunControls form, danger-zone reset (chroma only). |
| `/run/reports/:timestamp` | `src/routes/RunReportDetail.tsx` | Single-report deep dive. Summary card + highlighted JSON dump. |
| `/settings` | `src/routes/Settings.tsx` | Sidebar that re-mounts the 8 setup step components for post-onboarding editing. |
| `*` | `src/routes/NotFound.tsx` | 404 with home link. No interactive behavior beyond the link. |

### 1B — Setup wizard step components

Common pattern: each step mounts a `useAutoSaveStep(N, data)` hook that
debounces a POST `/api/setup/save-step` with `{ step, data }`.

| Step | File | Inputs | Side-effects |
|---|---|---|---|
| 1 — Project basics | `src/routes/setup/Step1ProjectBasics.tsx` | `project_name`, `corpus_path` text inputs. | Autosave step 1; no other network. |
| 2 — Vector DB | `src/routes/setup/Step2VectorDB.tsx` | Adapter radio (6 options); per-adapter fields (chroma_path/collection, qdrant_url/api_key, pinecone_api_key/index/cloud/region/namespace, weaviate_url/api_key/collection, pgvector_dsn/table, other_adapter_module/class); Test connection button. Chroma-only: ResetVectorStoreButton (mounted twice in Run as well). | Autosave step 2; POST `/api/setup/test-vectordb`. |
| 3 — Models | `src/routes/setup/Step3Models.tsx` | Three `use_local_*` checkboxes; `anthropic_api_key` + show/hide eye + Test; `oracle_model` text; vLLM Start/Stop buttons; copy-vLLM-command; `vllm_base_url` + Test; `prejudge_model`, `embedding_model`, `reranker_model` text. | Autosave step 3; POST `/api/setup/test-anthropic`, `/api/setup/test-vllm`, `/api/system/vllm/start`, `/api/system/vllm/stop`; polled `/api/system/vllm/status` (2 s) gated on `use_local_prejudge`; auto-fires vLLM Test on transition to `"ready"`. |
| 4 — Cost | `src/routes/setup/Step4Costs.tsx` | `usd_per_run`, `tokens_per_iteration`, `cache_ttl_hours`, `subset_eval_size` number inputs. | Autosave step 4. |
| 5 — Seed target | `src/routes/setup/Step5SeedTarget.tsx` | Single `seed_target_n` Slider (10–200 step 5). | Autosave step 5. |
| 6 — GPU | `src/routes/setup/Step6GPU.tsx` | "Detect GPU now" / "Re-detect" probe button. | POST `/api/setup/probe` on mount + click; on `isSuccess` fires POST `/api/setup/save-step` with `{step:6, data:{}}` once to mark complete. Reads `config?.models.use_local_*` to build VRAM breakdown. |
| 7 — Stopping | `src/routes/setup/Step7Stopping.tsx` | `convergence_threshold`, `convergence_window`, `max_iterations`, `anchor_regression_threshold` number inputs; `regression_policy` 2-button radio (warn/block). | Autosave step 7. |
| 8 — Judge weights | `src/routes/setup/Step8JudgeWeights.tsx` | Three Sliders (`correctness`, `recall_at_5`, `faithfulness`). Sum-to-1 banner. | Autosave step 8. |

### 1C — Authoring components

| Component | File | User actions | Observable outcomes / cross-cutting concerns |
|---|---|---|---|
| `Authoring` | `src/routes/Authoring.tsx` | Click "From the corpus" tab; click "From a question" tab; click Run link; click Settings link. | Progress bar reads `useSeedList` (cases.length / target_n); celebratory banner appears when `total >= target_n`; spinner while `useConfig` loads; rendered child sub-tree swaps on mode change. Mode state is local-only — switching tabs unmounts the inactive wizard, dropping its in-progress state. |
| `CorpusBrowser` | `src/routes/authoring/CorpusBrowser.tsx` | Click "Ingest corpus"; passive file list. | Mutation: `useStartIngest`. Polls `useIngestStatus(500)`. On status `succeeded` → push success toast AND `qc.invalidateQueries(['corpus-files'])`. On `failed` → push error toast with backend error. Renders progress bar (files_done/total), chunks/sec, current_file. |
| `CaseWizardFromCorpus` | `src/routes/authoring/CaseWizardFromCorpus.tsx` | Click "Ingest corpus" (left rail copy); click a file in rail; Prev/Next pagination buttons; click a passage to anchor; "Change" anchor; "Highlight passage list"; type Question / Ground-truth / Notes; select Category; click Save; click Discard; toggle "Also run pipeline" (via embedded ValidationPanel). | Same ingest side-effects as `CorpusBrowser` (toast + `['corpus-files']` invalidate). Passage list ref pulse 1.5 s. Autosave draft every 2 s. Debounced validate at 600 ms. Save calls `useSeedSave.mutateAsync` → success toast `n/target` and resets to empty-state with file selection preserved. Mounts `ValidationPanel`. |
| `CaseWizard` (legacy from-question) | `src/routes/authoring/CaseWizard.tsx` | Type Question, Ground-truth, Notes; select Category; click Save; click Discard; toggle pipeline; passage picker actions (delegated). | Autosave draft every 2 s. Debounced validate at 600 ms. Save → toast + reset (no file to preserve). Mounts `PassagePicker`. |
| `PassagePicker` | `src/routes/authoring/PassagePicker.tsx` | Expand/collapse chevron per result; Add/Remove button per result. | Debounced (350 ms) `useCorpusSearch.mutate`. `selected` is a controlled prop. Empty state when < 3 chars or 0 results. Error state on `isError`. |
| `ValidationPanel` | `src/routes/authoring/ValidationPanel.tsx` | "Also run through pipeline" checkbox. | Renders loading spinner / error block / empty prompt / two ValidationRows / warnings block / pipeline-score block. Surfaces `[data-valid]` and per-row labels. |
| `DraftList` | `src/routes/authoring/DraftList.tsx` | Click draft to fire `onSelect(id)`; click trash icon to delete. | `useSeedDrafts` reads. `useDeleteDraft.mutate(id)` → push "Draft discarded" info toast on success. |
| `GeneratedList` | `src/routes/authoring/GeneratedList.tsx` | Click row to expand/collapse. | Reads `useGeneratedFiles`; lazily fetches `useGeneratedCases(timestamp)` only when expanded (`enabled: !!timestamp`). Read-only. |

### 1D — Run dashboard sub-views (all live in `Run.tsx`)

| Sub-view | Inputs | Outputs |
|---|---|---|
| `TopBar` | Reads `current`, `delta`, `stopReason`, `running`, `streamConnected`. | Metric tiles (composite, pass rate, iteration, p95). StatusDot ("Running"/"Idle" + "live"/"offline"). StopBadge with colored variant. |
| `CompositeChart` | `points`, `onPointClick`. | SVG with `data-testid="composite-chart"` + `data-points`; clickable `chart-point-hit` per iteration → navigates to `/run/reports/<ts>`. |
| `PerCategoryTrend` | `reports`. | One `CategoryMini` SVG per category seen in reports. |
| `CategoryMini` | `category`, `series`. | Mini SVG + last value. |
| `CostBars` | `reports`. | Summed-USD figure + bars per iteration. |
| `DriftTimeline` | `reports`. | Sparkline + latest %; switches red when any value > 5 %. |
| `CostMeter` | `current`, `budgetUSD`. | usd_spent + cap + overrun bar + cost dl. |
| `PerCategoryBars` | `current`. | Sorted (worst first) bars per category. |
| `RegressionList` | `current`. | Table of regressions with previous/current/Δ. |
| `RunControls` | iterations (number), budget USD (number), skip_red (cb), no_agents (cb), Start/Stop buttons. | `useStartLoop.mutate({iterations, budget_usd, skip_red, no_agents})`; `useStopLoop.mutate()`. Start error text. Conditional ResetVectorStoreButton (chroma only, disabled while running). |

### 1E — Shared components

| Component | File | User actions | Notes |
|---|---|---|---|
| `ResetVectorStoreButton` | `src/components/ResetVectorStoreButton.tsx` | Open trigger; type confirmation; Cancel; click "Wipe vector store"; click backdrop. | Mounted in Step 2 and in Run's controls. Disabled when ingest running. On success: pushToast + close; hook invalidates `['ingest-status']` and `['corpus-files']`. |
| `ConnectionBadge` | `src/components/ConnectionBadge.tsx` | None (display only). Exports `explainAnthropicError`, `explainVLLMError`. | Color-codes idle/testing/ok/fail/warn. |
| `Slider` | `src/components/Slider.tsx` | Range drag. | Emits `data-testid="slider-<slug>"` and `data-percentage`. |
| `Button`, `Card`, `Field`, `Spinner`, `StepIndicator`, `Toast` | various | Mostly presentational; `Toast` consumes the global `useUIStore` toast queue. | |

---

## Section 2 — Coverage matrix

Columns: **C** = component, **A** = user action, **O** = observable
outcome. **Covered by** = file:line of the asserting test (best
existing one); **GAP** reason if absent. The audit honors the
distinction between "test renders the DOM containing X" and "test
asserts that X is the consequence of the triggering action".

Test-file shorthand:
- `CB.A` = `CorpusBrowser.actuation.test.tsx`
- `CB.T` = `CorpusBrowser.test.tsx`
- `CWFC.A` = `CaseWizardFromCorpus.actuation.test.tsx`
- `CWFC.T` = `CaseWizardFromCorpus.test.tsx`
- `CW.A` = `CaseWizard.actuation.test.tsx`
- `CW.T` = `CaseWizard.test.tsx`
- `VP.A` = `ValidationPanel.actuation.test.tsx`
- `VP.T` = `ValidationPanel.test.tsx`
- `PP.A` = `PassagePicker.actuation.test.tsx`
- `PP.T` = `PassagePicker.test.tsx`
- `DL.T` = `DraftList.test.tsx`
- `GL.T` = `GeneratedList.test.tsx`
- `S<n>.A`, `S<n>.T` = `Step<n>...actuation.test.tsx` / `Step<n>...test.tsx`
- `R.A`, `R.T` = `Run.actuation.test.tsx` / `Run.test.tsx`
- `RRD.T` = `RunReportDetail.test.tsx`
- `St.A` = `Settings.actuation.test.tsx`
- `Auth.T` = `Authoring.test.tsx`
- `RVS.T` = `ResetVectorStoreButton.test.tsx`
- `e2e/<file>` = Playwright

### Authoring journey

| C | A | O | Covered by | GAP reason |
|---|---|---|---|---|
| Authoring | click "From the corpus" tab | `aria-selected=true` on that tab, wizard swaps | Auth.T:188 (defaults to from-corpus) | GAP — no test clicks the tab from `from-question` and asserts the wizard mounted swaps to `CaseWizardFromCorpus`. |
| Authoring | click "From a question" tab | wizard swaps to `CaseWizard` | GAP | The mode toggle's click handler is never driven in any test. |
| Authoring | mid-draft tab switch | typed text preserved (or confirm dialog) | GAP | The test-audit doc flagged this explicitly (TODO #9). |
| Authoring | Run link click | navigates to `/run` | Auth.T:174 only asserts the link exists. **GAP** — no test asserts navigation. |
| Authoring | Settings link click | navigates to `/settings` | Auth.T:174 only asserts the link exists. **GAP**. |
| Authoring | seed_list grows (after Save in child) | progress bar `aria-valuenow` updates | Auth.T:152 renders a fixed count. **GAP** — no test mounts the parent + saves a case and asserts the bar moves (cross-query: `['seed-list']` invalidated by `useSeedSave`). |
| Authoring | seed_list reaches target | celebratory banner appears | Auth.T:165 (renders banner from canned data). **GAP** — no transition test from below-target to at-target. |
| CorpusBrowser | click "Ingest corpus" idle | `useStartIngest.mutate()` fires once | CB.A:51 ✓ | |
| CorpusBrowser | click "Ingest corpus" while running | disabled, mutation NOT fired | CB.A:72 ✓ | |
| CorpusBrowser | ingest status flips to `succeeded` | success toast pushed | CB.T:136 ✓ | |
| CorpusBrowser | ingest status flips to `succeeded` | `['corpus-files']` query invalidated → list re-fetches and `not ingested` flips to `n chunks` | **GAP — this is the 2026-05-24 ingest bug.** No test asserts the QueryClient invalidate happened; both hooks are independent mocks so the coupling is invisible. |
| CorpusBrowser | ingest status flips to `failed` | error toast with backend error | CB.T:158 ✓ | |
| CorpusBrowser | running state | progress bar shows files_done/total + chunks/sec | CB.T:96 ✓ | |
| CorpusBrowser | passive file list | renders each file with chunk-count badge or "not ingested" | CB.T:65 ✓ | |
| CorpusBrowser | passive file list | empty-state when 0 files | CB.T:74 ✓ | |
| CaseWizardFromCorpus | click "Ingest corpus" in left rail | mutation fires + `from-corpus-ingest-progress` appears | GAP — no actuation test clicks the from-corpus-specific ingest button. |
| CaseWizardFromCorpus | ingest success here | success toast AND `['corpus-files']` invalidated (the file rail refreshes badges) | GAP — same class as CorpusBrowser. The file rail re-uses `useCorpusFiles` and the wizard re-uses `useIngestStatus`; nothing asserts a from-corpus-mode user clicking ingest sees the badges update. |
| CaseWizardFromCorpus | click a file in rail | passages load, `aria-pressed=true` on file | CWFC.T:150 ✓ | |
| CaseWizardFromCorpus | empty state visible pre-anchor | `empty-state-no-anchor` testid + "Click a passage above…" copy | CWFC.T:160, CWFC.T:382 ✓ | |
| CaseWizardFromCorpus | textareas absent pre-anchor | `queryByLabelText(/question/)` is null | CWFC.A:152, CWFC.A:159, CWFC.A:168, CWFC.A:175 ✓ | |
| CaseWizardFromCorpus | Save disabled pre-anchor | button.disabled | CWFC.A:182 ✓ | |
| CaseWizardFromCorpus | click a passage | anchored-passage banner shown, textareas mount | CWFC.T:175, CWFC.T:424 ✓ | |
| CaseWizardFromCorpus | type Question | textarea value matches | CWFC.A:193 ✓ | |
| CaseWizardFromCorpus | type Ground-truth | textarea value matches | CWFC.A:203 ✓ | |
| CaseWizardFromCorpus | type Notes | textarea value matches | CWFC.A:227 ✓ | |
| CaseWizardFromCorpus | select Category | value persists + description shown | CWFC.A:215 ✓ | |
| CaseWizardFromCorpus | click Save (happy path) | seedSave called with correct passage + payload | CWFC.A:237, CWFC.T:221 ✓ | |
| CaseWizardFromCorpus | click Save | post-save: clears form, keeps file selected | CWFC.T:263 ✓ | |
| CaseWizardFromCorpus | click Save | success toast `n/target` | CWFC.T:304 ✓ | |
| CaseWizardFromCorpus | click Save | `['seed-list']` invalidates → Authoring progress bar moves | **GAP** — the `useSeedSave` hook DOES invalidate `['seed-list']`, but no test mounts both Authoring + the wizard and asserts the cross-query refresh. |
| CaseWizardFromCorpus | click Save | new draft id (post-save fresh draft) — old draft still persisted on disk | GAP — no test verifies the just-saved draft is **not** re-saved by autosave. |
| CaseWizardFromCorpus | Save fails | error toast with backend message | CWFC.T:337 ✓ | |
| CaseWizardFromCorpus | click "Change" anchor | empty state restored, textareas gone | CWFC.T:470 ✓ | |
| CaseWizardFromCorpus | re-anchor after Change | typed question cleared | CWFC.T:484 ✓ | |
| CaseWizardFromCorpus | click "Highlight passage list" | `data-pulse="true"` then back to `false` after ~1.5 s | CWFC.T:405 ✓ | |
| CaseWizardFromCorpus | Prev/Next pagination | `setPage` advances; `useCorpusPassagesPaginated` re-fires with new offset | GAP — no test verifies the offset moves in the next query call. |
| CaseWizardFromCorpus | click Discard | form clears but file selection preserved | GAP — no test asserts the Discard button's exact behavior. |
| CaseWizardFromCorpus | autosave fires | `useSaveDraft.mutate(id, draft)` called within 2 s of editing | GAP — interval-based effect is not driven by any test. |
| CaseWizardFromCorpus | validate fires | `useSeedValidate.mutate` called 600 ms after edits stop | GAP — debounce timing not exercised. |
| CaseWizard (legacy) | type Question/Ground-truth/Notes | values persist | CW.A:97, CW.A:105, CW.A:113 ✓ | |
| CaseWizard | select Category | value persists | CW.A:121 ✓ | |
| CaseWizard | click Discard | fields cleared | CW.A:143 ✓ | |
| CaseWizard | click Save (happy) | seedSave called with typed payload | CW.A:187 ✓ | |
| CaseWizard | Save disabled when no category | button.disabled | CW.A:155 ✓ | |
| CaseWizard | passages added via PassagePicker | appear in selected list with X-removal button | GAP — the parent-child coupling between PassagePicker and CaseWizard (`onAdd` propagates → selected re-renders → debounced validate fires) is not exercised end-to-end. PassagePicker tests pass `selected` as a static prop. |
| CaseWizard | passage X-remove | passage drops out + validate re-fires | GAP — same. |
| CaseWizard | autosave fires | draft saved every 2 s | GAP. |
| ValidationPanel | toggle "Also run pipeline" | onToggle(true/false) fires | VP.A:28 ✓ | |
| ValidationPanel | runPipeline=true on mount | checkbox checked | VP.A:44 ✓ | |
| ValidationPanel | result.passages_in_top_k=false | failed row renders with red icon + "0 of N found" | VP.T:84 ✓ | |
| ValidationPanel | isLoading=true | spinner visible | VP.T:35 ✓ | |
| ValidationPanel | isError=true | error message rendered | VP.T:48 ✓ | |
| ValidationPanel | runPipeline=true + isLoading=true | toggle still rendered | GAP — test-audit class-5 gap; the loading branch shadows the toggle today. |
| ValidationPanel | warnings present + valid result | warnings list renders alongside checks | VP.T:101 ✓ but no combined-state assertion. |
| ValidationPanel | uningested-corpus real backend | warnings copy mentions "ingest" / "vector store empty" / similar | e2e/uningested-corpus.spec.ts:139 ✓ | |
| PassagePicker | expand chevron | only that result expands; others stay collapsed | PP.A:95 ✓ | |
| PassagePicker | collapse chevron | result re-collapses | PP.A:118 ✓ | |
| PassagePicker | add button | onAdd fired with passage payload | PP.A:69 ✓ | |
| PassagePicker | remove button (already selected) | onRemove fired with ref | PP.A:141 ✓ | |
| PassagePicker | debounced search | useCorpusSearch.mutate called after 350 ms | PP.T (renders search result) but no debounce-timing assertion. **GAP**. |
| PassagePicker | < 3-char query | empty prompt visible | PP.T ✓ (implied via empty result shown). |
| DraftList | click row | onSelect(id) fires | DL.T:88 ✓ | |
| DraftList | click trash | delete mutation + info toast | DL.T:71 ✓ | |
| DraftList | autosave from wizard adds a draft | DraftList re-fetches and the new draft appears | **GAP — cross-query**: `useSaveDraft` invalidates `['seed-drafts']`; no test mounts both wizard + DraftList and asserts the row appears. |
| DraftList | empty state | "No drafts yet" copy | DL.T:53 ✓ | |
| GeneratedList | expand row | aria-expanded + cases appear | GL.T:84 ✓ | |
| GeneratedList | collapse row | cases hidden | GL.T:134 ✓ | |
| GeneratedList | read-only (no edit/delete) | no buttons named delete/edit/save | GL.T:112 ✓ | |
| GeneratedList | red-team loop runs, list refreshes | new file appears without manual refresh | GAP — no polling and no explicit invalidate on the loop; relies on natural staleTime. **GAP** if intended. |

### Setup wizard journey

| C | A | O | Covered by | GAP |
|---|---|---|---|---|
| SetupWizard | route `/setup` (no step param) | parses to step 1 | SetupWizard.test.tsx (assumed default render) — **VERIFY**. |
| SetupWizard | click Next on step < 8 | navigate `/setup/<n+1>` | wizard.spec.ts:48 ✓ + SetupWizard.test.tsx | |
| SetupWizard | click Next on step 8 | `useFinishSetup` mutate → `/authoring` redirect + "Setup complete" toast | wizard.spec.ts:127 ✓ | |
| SetupWizard | click Previous | navigates back | GAP — no test drives Previous specifically. |
| SetupWizard | click "Skip to defaults" | finishSetup + redirect + info toast | GAP — `skip-to-defaults` testid is never clicked in any test. |
| SetupWizard | sidebar StepIndicator | `completed_steps` produces checkmarks; current step highlighted | wizard-walk-full.spec.ts:306 partial. **GAP** — no unit test mocks `completed_steps: [1,2,3]` and asserts the right indicators light up. |
| Step1ProjectBasics | type project_name | autosave payload includes it | S1.A (assumed parallel to S2-S8). **VERIFY**. |
| Step1ProjectBasics | type corpus_path | autosave payload includes it | (same) |
| Step2VectorDB | click each adapter | per-adapter panel appears + `aria-pressed` flip | S2.A:65 ✓ (Chroma, Qdrant); S2.A:79 (Qdrant); each panel inferred from inputs reachable later. |
| Step2VectorDB | type qdrant_url | save payload populated | S2.A:87 ✓ |
| Step2VectorDB | type pinecone fields | save payload populated | S2.A:100, S2.A:117 ✓ |
| Step2VectorDB | type weaviate fields | save payload | S2.A:144 ✓ |
| Step2VectorDB | type pgvector DSN | save payload | S2.A:161 ✓ |
| Step2VectorDB | type other_adapter_* | save payload | S2.A:182 ✓ |
| Step2VectorDB | click Test connection | POST /test-vectordb per adapter | S2.A:204 ✓ (loops all 6) |
| Step2VectorDB | Test returns `ok=true` | green badge | e2e/setup-test-buttons.spec.ts:63 (chroma only) ✓ |
| Step2VectorDB | Test returns `ok=false` with arbitrary error blob | error text rendered verbatim ("tenant does not exist" etc.) | **GAP — Chroma tenants bug**. No test mocks `{ok:false, error:'...'}` and asserts the verbatim copy renders. |
| Step2VectorDB | switch adapter mid-test | previous test result cleared, badge resets | e2e/error-recovery.spec.ts:36 ✓ (chroma↔qdrant) |
| Step2VectorDB | ResetVectorStoreButton (chroma) | trigger + modal + confirm + toast | RVS.T entire file ✓ |
| Step2VectorDB | ResetVectorStoreButton hidden (non-chroma) | not rendered when adapter≠chroma | GAP — not asserted. |
| Step3Models | click `use_local_embedding` toggle | autosave payload `use_local_embedding=false` | S3.A:131 ✓ |
| Step3Models | click `use_local_reranker` toggle | autosave | S3.A:131 ✓ |
| Step3Models | click `use_local_prejudge` toggle | autosave + vLLM section may show/hide | S3.A:131 covers payload; **GAP** — no test asserts that toggling `use_local_prejudge=false` HIDES the `GetVLLMRunningCard` (`{data.use_local_prejudge && <GetVLLMRunningCard ...>}` branch on line 231). |
| Step3Models | type api_key + Anthropic Test | POST /test-anthropic with key + model | S3.A:159 ✓ |
| Step3Models | bad api_key Test | renders friendly copy (not raw JSON) | e2e/setup-test-buttons.spec.ts:18 ✓ |
| Step3Models | type vllm_base_url + vLLM Test | POST /test-vllm with new URL | S3.A:175 ✓ |
| Step3Models | vLLM Test with connection refused | amber warn (not red error) | e2e/setup-test-buttons.spec.ts:44 ✓ |
| Step3Models | type oracle/prejudge/embedding/reranker_model | autosave payload | S3.A:75–S3.A:130 ✓ |
| Step3Models | eye toggle | password ↔ text type | S3.A:193 ✓ |
| Step3Models | vLLM Start button | POST /system/vllm/start with model + port | GAP — `vllm-start-button` testid is never clicked. |
| Step3Models | vLLM Start succeeds → state="ready" | (a) auto-fires vLLM Test, (b) pushes "vLLM is up" toast, (c) `vllm-ready-hint` text appears | **GAP** — this 4-line side-effect chain (Step3Models.tsx:95–107) is one of the most fragile in the app and not asserted by any test. |
| Step3Models | vLLM Start fails with `vllm_not_installed` | `vllm-not-installed-message` testid appears | GAP. |
| Step3Models | vLLM Stop button | POST /system/vllm/stop | GAP. |
| Step3Models | copy command button | navigator.clipboard.writeText fires + "Copied" copy briefly | GAP. |
| Step3Models | toggle `use_local_prejudge=false` | useVLLMStatus polling STOPS | GAP — the `data.use_local_prejudge ? 2000 : false` arg is never asserted. |
| Step4Costs | type any of 4 number fields | autosave | S4.T + S4.A (assumed) — **VERIFY** these exist. |
| Step5SeedTarget | drag slider | autosave + clamps to min/max | S5.T:slider drag + clamp — **VERIFY**. |
| Step6GPU | "Detect GPU now" click | probe.mutate fires | S6.A:81 ✓ |
| Step6GPU | "Re-detect" click N times | probe fires N times | S6.A:98 ✓ |
| Step6GPU | isPending | button disabled | S6.A:117 ✓ |
| Step6GPU | probe.isSuccess | one-shot `save-step` for step 6 fires (marks complete in sidebar) | GAP — the ref-guarded effect on Step6GPU.tsx:64 is critical for the step-completed checkmark and never asserted. |
| Step6GPU | config has `use_local_embedding=false` | `vram-row-embedding` NOT in DOM | **GAP — VRAM math toggles bug** (test-audit TODO #3). |
| Step6GPU | config has `use_local_reranker=false` | `vram-row-reranker` NOT in DOM | **GAP**. |
| Step6GPU | config has `use_local_prejudge=false` | `vram-row-prejudge` NOT in DOM | **GAP — TODO #4**. |
| Step6GPU | wantedMb > vram_total_mb | `vram-warning` banner appears | GAP — banner is rendered but not asserted on. |
| Step6GPU | GPU not detected | amber banner with fallback copy | S6.T (assumed) — **VERIFY**. |
| Step7Stopping | type each numeric input | autosave payload populated | S7.T + S7.A — wire-shape coverage cited in test-audit; assumed ✓. |
| Step7Stopping | click "Warn (continue)" / "Block (stop loop)" | aria-pressed flips + autosave includes `regression_policy` | wizard-walk-full.spec.ts:340 ✓ |
| Step8JudgeWeights | drag correctness slider | autosave `judge_weights.correctness` only (not the others) | S8.A:58 partial ✓; **GAP** — no test asserts the OTHER two weights are untouched in the same payload (catches slider mis-mapping). |
| Step8JudgeWeights | drag recall / faithfulness | same as above | S8.A:70, S8.A:82 partial ✓ + same gap. |
| Step8JudgeWeights | weights sum ≠ 1.0 | "should sum to 1.00" banner replaces "(valid)" | S8.A:94, wizard-walk-full.spec.ts:373 ✓ |
| Step8JudgeWeights | weights sum ≠ 1.0 | Next button DISABLED | **GAP** — sum-to-1 is purely a banner today; user can advance to /authoring with mis-summed weights. Whether intended or not, no test asserts which. |
| Step8JudgeWeights | data-percentage matches value | percentage attribute updates on drag | S8.A:116 ✓ |

### Run journey

| C | A | O | Covered by | GAP |
|---|---|---|---|---|
| Run | mount with idle status | Start button visible, Stop hidden | R.T:221 ✓ |
| Run | mount with running status | Stop button visible, Start hidden, inputs disabled | R.T:227, R.T:305 ✓ |
| Run | type iterations | accepts int; clamps to 0 | R.A:186, R.A:311 ✓ |
| Run | type budget USD | accepts decimal | R.A:196 ✓ |
| Run | toggle skip_red | checked flips | R.A:204 ✓ |
| Run | toggle no_agents | checked flips | R.A:215 ✓ |
| Run | click Start | startLoop.mutate({iterations, budget_usd:null, skip_red, no_agents}) | R.A:223 ✓ |
| Run | click Start with budget | budget_usd: parsed number | R.A:276 ✓ |
| Run | click Stop while running | stopLoop.mutate fires | R.A:293, R.T:287 ✓ |
| Run | start.isError | error message displayed | R.T:379 ✓ |
| Run | latestReport null + empty history + connected false | "No iterations yet" empty state | R.T:330 ✓ |
| Run | stream connected | "live" text | R.T:342 ✓ |
| Run | stream disconnected | "offline" text | R.T:347 ✓ |
| Run | useLoopStream `connected=false` AND useLoopStatus `running=true` | reconnect / "connection lost" indicator | **GAP — TODO #12**. The two values just render side-by-side ("Running · offline") without surfacing the inconsistency. |
| Run | stop_reason set on report | StopBadge rendered with reason | R.T:237 ✓ |
| Run | composite chart point click | navigates to `/run/reports/<ts>` | R.T:468 ✓ |
| Run | latest report cost over budget | red overrun bar | R.T:357 ✓ |
| Run | drift > 5% | drift-svg `data-warn="true"`, red text | R.T:451 ✓ |
| Run | regressions present | table with prev/current/Δ | R.T:214 ✓ |
| Run | regressions empty | no-regressions copy | R.T:402 ✓ |
| Run | per-category bars sort worst→best | order asserted | R.T:203 ✓ |
| Run | per-category trend (multi iter) | mini-chart per category | R.T:418 ✓ |
| Run | cost bars (multi iter) | one bar per iter, sum displayed | R.T:433 ✓ |
| Run | adapter≠chroma | ResetVectorStoreButton NOT rendered | GAP. |
| Run | adapter=chroma + running | ResetVectorStoreButton disabled (`pointer-events-none`) | GAP — visual gate, not asserted. |
| Run | stream emits `iteration_complete` event | reports array grows; chart `data-points` increments | GAP — no test drives the WebSocket onmessage handler. |
| Run | stream emits `loop_stopped` | lastStopReason="manual" if no reason yet | GAP. |
| Run | seed_list/cost overrun → loop should stop | not the UI's concern, but the **`['loop-status']` polled by useLoopStatus** must keep firing — no test verifies polling cadence. | GAP. |
| RunReportDetail | mount with timestamp | useReportByTimestamp called with decoded ts | RRD.T:183 ✓ |
| RunReportDetail | data loaded | summary card + JSON highlighter | RRD.T:197, RRD.T:216 ✓ |
| RunReportDetail | isError | error message with backend message | RRD.T:251 ✓ |
| RunReportDetail | Back to Run click | navigates to `/run` | RRD.T:236 ✓ |
| RunReportDetail | unknown timestamp on real backend | 404 → error message (not crash) | GAP — only mocked failure tested. |
| Settings | click each of 8 sidebar buttons | corresponding section renders | St.A all 8 ✓ |
| Settings | edit value in section A, switch to B, switch back to A | edited value persists in DOM | **GAP** — `Settings` recreates the section component on every nav; child components reset from `config?` on each mount. No test asserts cross-nav persistence. |
| Settings | edit field → switch nav → server PATCH already landed | GET /api/config matches | e2e/settings-parity.spec.ts ✓ |
| Settings | sidebar persists across reload | active section restored? | GAP — `active` is local state; reload returns to "project". No test asserts the (lack of) persistence. |

### Cross-cutting cache invalidations (the load-bearing matrix)

| Invalidation declared in hooks.ts | Triggered by | Consumer that depends on the refresh | Test that asserts the cross-component refresh |
|---|---|---|---|
| `['setup-state']` invalidated by `useSaveStep`, `useFinishSetup` | every step autosave + finish | `useSetupState` powers `HomeRedirect` + `StepIndicator` completed badges | wizard-walk-full.spec.ts:306 only — no unit test mounts the indicator and asserts a save advances `completed_steps`. |
| `['config']` set by `useSaveStep`, `useFinishSetup`, `usePatchConfig` | every step autosave | every step's `useEffect(()=>setData(config.X), [config])` | GAP — no test mounts a step component, fires a save, and asserts the local `data` state reconciles with the new config (would catch field-dropping by Pydantic `extra=ignore`). e2e covers some of this. |
| `['ingest-status']` invalidated by `useStartIngest`, `useResetVectorStore` | click Ingest + click Reset | `useIngestStatus` poll | GAP — no unit test asserts the invalidate happens. |
| `['corpus-files']` invalidated by useEffect on `ingestStatus.state==="succeeded"` in `CorpusBrowser` AND `CaseWizardFromCorpus`, and by `useResetVectorStore` | ingest finishes, vector store reset | `useCorpusFiles` consumers (both CorpusBrowser file list and from-corpus file rail) | **GAP — the 2026-05-24 bug**. Both consumers mock `useCorpusFiles` and `useIngestStatus` as separate fns; the `useQueryClient().invalidateQueries(['corpus-files'])` call is invisible to the test. Also there's a duplicate of this effect in `CaseWizardFromCorpus.tsx:111` — equally untested. |
| `['seed-list']` invalidated by `useSeedSave` | click Save in either wizard | Authoring progress bar + the "reached target" banner | GAP — Authoring.test.tsx mocks `useSeedList` directly; no test wires the mutation through to the progress bar. |
| `['seed-drafts']` invalidated by `useSaveDraft`, `useDeleteDraft` | autosave + delete | DraftList | GAP — DraftList tests mock `useSeedDrafts` independently. |
| `['loop-status']` invalidated by `useStartLoop`, `useStopLoop` | Start/Stop click | RunControls disabled-input branch + Stop button visibility | GAP — Run tests mock `useLoopStatus` independently of `useStartLoop` mutation. |
| `['vllm-status']` set by `useStartVLLM`, invalidated by `useStopVLLM` | vLLM start/stop click | Step 3's `GetVLLMRunningCard` state badge + auto-Test transition | GAP — `useVLLMStatus` is never driven through a state-change cycle in tests. |

---

## Section 3 — Categorize gaps

### 3.1 Cross-query invalidation (the 2026-05-24 class)

One query's success/state change is supposed to invalidate another
query's cache; the test mocks both hooks as independent puppets so
the coupling is invisible. **Recommendation: integration tests using
a real `QueryClient` with stubbed `fetch`/`request` (not mocked
hooks).**

| Coupling | Where | Why it matters |
|---|---|---|
| `useIngestStatus.state="succeeded"` → invalidate `['corpus-files']` | `CorpusBrowser.tsx:29`, `CaseWizardFromCorpus.tsx:114` | The user's "ingest worked but the badges still say not-ingested" bug. |
| `useResetVectorStore.onSuccess` → invalidate `['ingest-status']` + `['corpus-files']` | `hooks.ts:380` | After a chroma reset the badges still claim n chunks. |
| `useSaveStep.onSuccess` → invalidate `['setup-state']` + set `['config']` | `hooks.ts:91` | The sidebar StepIndicator's checkmark requires the round-trip; if Pydantic drops fields, the next-step component sees stale data. |
| `useSeedSave.onSuccess` → invalidate `['seed-list']` | `hooks.ts:207` | Progress bar move and "target reached" banner. |
| `useSaveDraft.onSuccess` → invalidate `['seed-drafts']` | `hooks.ts:230` | New draft must appear in DraftList in the next 2-second tick. |
| `useStartLoop` / `useStopLoop.onSuccess` → invalidate `['loop-status']` | `hooks.ts:320`, `hooks.ts:329` | Start/Stop button visibility depends on this. |

**Test type recommendation: integration (vitest + jsdom + real
QueryClient + msw or stubbed `request`)**. Each integration test mounts
the parent component + child siblings, drives the action, and asserts
the consumer re-renders with fresh data. Roughly 20–40 LOC each.

### 3.2 State transitions (the test renders state X or Y, not X→Y)

Tests pre-set the hook to its terminal state and assert the rendered
DOM, without ever firing the transition that lands the component in
that state.

| Transition | Component | Today |
|---|---|---|
| vLLM `stopped` → `starting` → `downloading` → `ready` | Step3Models / GetVLLMRunningCard | No test mocks a state evolution; lastSeenStateRef gating not exercised. |
| ingest `idle` → `running` → `succeeded` | CorpusBrowser | CB.T:136 simulates the final state by remounting; the effect fires but no test asserts BOTH the toast AND the invalidate. |
| ingest `running` → `failed` | CorpusBrowser | CB.T:158 same shape. |
| loop `idle` → `running` (Start clicked) | Run | R.T:287 fires Start but useLoopStatus is independently mocked, so the Stop-button-appears transition isn't covered as a consequence. |
| GPU probe `pending` → `success` → save-step fired once | Step6GPU | S6.A:81 fires the click; the `markedDone` ref-guarded one-shot effect on Step6GPU.tsx:64 is never observed. |
| `seed-list` total < target → total ≥ target | Authoring | banner-shown is tested as a snapshot only. |

**Test type: unit (vitest) with `rerender`** — mount with state X, then
`rerender` with state Y, assert the consequence. ~10 LOC each.

### 3.3 Observable persistence (DOM mutation vs disk round-trip)

The test asserts an in-memory state change but never that the value
round-trips through the backend store. Wire-shape regressions
(Pydantic `extra=ignore` etc.) pass.

| Field | Test today | Disk assertion |
|---|---|---|
| Step 3 `use_local_*` toggles | actuation captures POST payload | wizard.spec.ts and wizard-walk-full do read YAML, but only assert `=true`. **GAP**: no test sets them to false and reads back false. |
| Step 3 `prejudge_model`, `embedding_model`, `reranker_model` | captured in actuation payload | YAML readback only asserts the api_key + oracle_model. **GAP**. |
| Step 3 vllm_base_url | captured in actuation | not asserted in YAML. **GAP**. |
| Authoring seed.jsonl notes/category | e2e/seed-authoring.spec.ts ✓ | covered. |
| Step 2 chroma_collection | wizard.spec.ts ✓ | covered. |
| Step 2 qdrant/pinecone/weaviate/pgvector/other fields | captured in unit actuation | **GAP** — no e2e walks through a non-chroma adapter and reads YAML. |
| Step 4 tokens_per_iteration, cache_ttl_hours | unit captured | not in wizard.spec.ts YAML assertion. |
| Step 7 convergence_window, anchor_regression_threshold | unit | YAML readback covers max_iterations + regression_policy; **GAP** on the other two. |

**Test type: e2e Playwright** because only a real backend round-trip can
detect Pydantic field-dropping. ~5–10 LOC per field added to existing
wizard.spec.ts.

### 3.4 Real-error paths (mocked `isError:true` vs the actual error)

Tests set `isError: true` and check that *some* error renders, but
don't simulate the actual backend response the user would hit.

| Real error | Mocked today | Actual mode |
|---|---|---|
| Chroma "tenant does not exist" 500 | Step 2 mocks `{ok:true}` | User typed wrong chroma_collection. Verbatim error must surface. **GAP — TODO #6**. |
| Anthropic 401 | e2e/setup-test-buttons ✓ — friendly copy verified | covered. |
| vLLM connection refused | e2e/setup-test-buttons ✓ — amber warn | covered. |
| Reset vector store fails server-side | RVS.T:221 mocks onError, asserts toast | covered. |
| `/api/seed/save` 409 duplicate | CWFC.T:337 mocks rejection | covered for from-corpus; **GAP** for question-first wizard. |
| `/api/setup/save-step` rejects (e.g. 422 schema invalid) | unit tests assume 200 always | **GAP** — no test surfaces what the user sees on autosave failure. |
| WebSocket close (loop stream) mid-iteration | useLoopStream sets connected=false; **GAP** — UI's reconnect copy is absent (TODO #12). |
| `/api/setup/test-vectordb` returns `{ok:false, error:"tenant…"}` | unit mocks ok:true; **GAP**. |

**Test type: e2e or integration with stubbed `fetch` returning the
realistic shape**. The "Chroma tenants" bug specifically needs a unit
test that mocks `useTestVectorDB` returning `{ok:false, error}` and
asserts the error string lands in the DOM verbatim.

### 3.5 Cross-tab / cross-route effects

An action in one route should be visible in another, or in a sibling
tab.

| Effect | Test today | GAP |
|---|---|---|
| Save in CaseWizardFromCorpus → Authoring header progress bar | seed-list invalidate only declared in hook | **GAP**. |
| Save in CaseWizard (question-first) → DraftList shows the draft | drafts invalidate | **GAP**. |
| Ingest in CorpusBrowser (question-first mode) → switch to from-corpus → file rail badges fresh | both components share `['corpus-files']` | **GAP** — and the duplicated effect in `CaseWizardFromCorpus.tsx:111` makes this brittle. |
| Mode tab switch in Authoring | typed text in inactive wizard preserved? | **GAP — TODO #9, #15**. |
| Reset vector store from Run dashboard → Authoring file rail flips badges to "not ingested" | hook invalidates `['corpus-files']` | **GAP**. |
| Run dashboard navigate → click chart point → /run/reports/:ts → "Back to Run" | covered | R.T:468 + RRD.T:271 ✓ |

**Test type: Playwright** because by definition these span routes /
mode tabs. ~30–60 LOC per spec; one per cross-cut.

### 3.6 Form gating (multi-input disabled states)

A button's `disabled` depends on a combination of state across
components; each component tests its slice but no test exercises the
joint condition.

| Gate | Disabled state depends on | Tested today |
|---|---|---|
| CaseWizardFromCorpus Save | passage anchored ∧ validate.passages_in_top_k ∧ validate.answer_text_in_passages ∧ category set | CWFC.A:182 (pre-anchor only); CWFC.T:213 (validation absent only). **GAP** — never the "anchor + question typed but no category" partial state, etc. |
| CaseWizard Save | passages.length>0 ∧ validate ∧ category | CW.A:155 partial. **GAP** — no test sets passages but no category. |
| Step6GPU "Re-detect" | probe.isPending | S6.A:117 ✓ |
| Step3Models vLLM Start button enabled iff `use_local_prejudge=true` AND state!=running | renders the card conditionally on use_local_prejudge | **GAP** — no test verifies the Start button is absent when prejudge OFF. |
| Step3Models Anthropic Test disabled when api_key empty | e2e/error-recovery.spec.ts:33 ✓ |
| ResetVectorStoreButton trigger disabled when ingest running | RVS.T:192 ✓ |
| ResetVectorStoreButton confirm enabled iff typed=="RESET" AND !ingestRunning | RVS.T:115 ✓; **GAP** — the AND with !ingestRunning is never verified jointly. |
| Step 8 Next disabled when sum≠1 | **GAP — TODO #14** (or document that this is intentional, then test that path). |
| Run Start disabled while running | R.T:305 ✓ |
| Run Reset disabled while running | only visual; `pointer-events-none` wrapper. **GAP**. |
| Run Stop button shows iff running ∧ loopStream connected (the "is it still running?" gap) | **GAP — TODO #12**. |

**Test type: unit** with a config grid — render the component with each
combination of inputs, assert disabled state. ~5 LOC per
combination.

---

## Section 4 — Prioritized fix list (top 15)

Ordered by user-impact × likelihood: how badly the bug hurts and how
common the user path is.

| # | Gap | Test type | LOC | Why first |
|---|---|---|---|---|
| 1 | **Ingest → corpus-files invalidate**: real-QueryClient integration test where `useIngestStatus` transitions to `succeeded` triggers a `['corpus-files']` refetch and the `not ingested` amber badge flips to `n chunks`. Cover both `CorpusBrowser` and `CaseWizardFromCorpus` file rails. | integration (vitest + real QueryClient + stubbed `request`) | ~80 (2 tests) | The 2026-05-24 trigger; the duplicate effect in CaseWizardFromCorpus.tsx:111 means a fix in one is silently un-fixed in the other. |
| 2 | **Step 6 VRAM toggles**: render `Step6GPU` with `config.models.use_local_embedding=false` and assert `vram-row-embedding` is absent and `vram-total-mb` excludes its MB. Repeat for `use_local_reranker=false`, `use_local_prejudge=false`. | unit | ~40 (3 tests) | The user-reported "VRAM math ignored toggles" bug; one of the most visible step-3↔step-6 couplings. |
| 3 | **Sliders mis-mapped**: in Step8JudgeWeights, drag *one* slider and assert the autosave payload's *other two* weight fields are UNCHANGED. Catches the slider→wrong-field bug. | unit | ~25 | User-reported bug; one-line `expect` change but high signal. |
| 4 | **Chroma tenants verbatim**: mock `useTestVectorDB` returning `{ok:false, error:"the tenant 'corpus' does not exist"}` and assert the verbatim error renders in the DOM. | unit | ~20 | Surfaces a class of "swallowed-error" bug at the layer where it bites. |
| 5 | **vLLM `use_local_prejudge=false` HIDES the card**: render `Step3Models` with the toggle off and assert `get-vllm-running` testid is absent. Symmetric: turn it ON and assert it appears. | unit | ~20 | "Step 3 vLLM section confusing" — confirms the intended visibility rule. |
| 6 | **Save in wizard → Authoring progress bar updates**: integration test mounts both Authoring + CaseWizardFromCorpus, saves a case via the wizard with stubbed `/api/seed/save`, and asserts the header progress bar's `aria-valuenow` increments without manual refresh. | integration | ~50 | The cross-query class, and a flow the SME runs dozens of times per session. |
| 7 | **Reconnect indicator when stream offline + loop running**: in `Run`, mock `useLoopStream({connected:false})` AND `useLoopStatus({running:true})` and assert a "connection lost" / "reconnecting" hint surfaces. | unit | ~15 | "Is it still running?" — direct user-reported pain. |
| 8 | **Authoring mode-tab switch preserves draft**: type a question in `from-corpus`, click `from-question` tab, click back, assert the textareas come back populated (or a confirm dialog appears — whichever is the design decision). | unit | ~30 | The mode toggle is the single switch every author touches; data loss here is silent. |
| 9 | **Step 3 → Step 6 cascade e2e**: in `wizard-walk-full.spec.ts`, toggle `use_local_embedding=false` in step 3, advance to step 6, assert the embedding row is NOT in the VRAM breakdown. | Playwright (extend existing spec) | ~25 | Catches the same VRAM bug at the level the user feels it; complements #2. |
| 10 | **Reset vector store → corpus-files refresh**: integration test fires reset and asserts both `['ingest-status']` and `['corpus-files']` are invalidated → file rail in either mode shows `not ingested` again. | integration | ~40 | Pairs with #1; same class of bug. |
| 11 | **Settings cross-section persistence**: type project_name in Project, click Vector DB, click back to Project, assert the typed value is still in the input. | unit | ~20 | The user-flagged "values not persisting" pattern hides here too because each section remounts. |
| 12 | **Step 3 vLLM lifecycle**: simulate `useVLLMStatus` evolving stopped→starting→downloading→ready in a `rerender` cycle, assert the auto-Test fires on the ready transition AND a success toast appears AND the state badge tracks each value. | unit | ~50 | The most fragile multi-step effect in the app; never asserted. |
| 13 | **Step 6 mark-completed**: assert that when `probe.isSuccess` becomes true, exactly one POST to `/api/setup/save-step` with `{step:6, data:{}}` fires, and a second probe.isSuccess (re-detect) does NOT re-fire it. | unit | ~30 | The ref-guarded one-shot effect is fragile and underpins the sidebar checkmark. |
| 14 | **Step 8 next-button gating**: with weights summing ≠ 1.0, assert the wizard-next button is disabled (or — if intentional — that it's enabled but a confirm dialog appears). Lock the design decision. | unit | ~15 | Currently nothing prevents progressing with bad weights; whether intended needs to be a test, not folklore. |
| 15 | **Step 2 non-chroma persistence e2e**: extend wizard-walk-full to switch to Qdrant, fill URL + collection, advance to finish, read YAML, assert vector_db.adapter=="qdrant" + all fields. | Playwright | ~40 | The unit actuation captures payload, but no e2e proves Pydantic actually persists the non-chroma fields. Pinecone has the most fields and is the highest-risk variant. |

**Total LOC: ~500 across 15 tests.** Mostly unit (6×), 3 integration,
2 Playwright extensions, 4 mixed. The class-3-and-1 fixes (cross-query
invalidation + state transitions) are the deltas from current
practice; everything else is incremental coverage of known issue
areas.

---

## Appendix — How to use this audit

1. **Pick from the top of Section 4** when allocating test work in a
   given pass — those are ranked by user pain × likelihood, not by
   ease of implementation.
2. **When fixing a bug, scan Section 2** for the corresponding triple
   and either (a) the test exists and you broke it, or (b) the row says
   GAP and you should add a test before declaring the bug fixed —
   otherwise we cycle through the same class again.
3. **When adding a new feature, fill in the inventory in Section 1**
   first, in this same shape (file, action, outcome, cross-cutting),
   so the next audit doesn't have to re-derive it.
4. **The Section 3.1 (cross-query) class is the most expensive to
   retrofit** because the existing tests mock hooks as independent
   puppets — fixing this requires switching to a real QueryClient and
   stubbed `request()`/`fetch`. The integration helpers don't exist
   yet; landing one helper module (~40 LOC) unblocks gaps #1, #6,
   #10 and any future cross-query test.
