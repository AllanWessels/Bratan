import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resetBratanState } from "./helpers";

/**
 * Wizard-walk verifier — drives ALL 8 setup-wizard steps in a real browser
 * against the live Vite dev server (http://127.0.0.1:5173) and FastAPI
 * backend (http://127.0.0.1:8000). Each assertion is wrapped in a
 * `test.step(...)` so the per-step pass/fail breakdown is visible in the
 * Playwright run output even when the overall test fails.
 *
 * The user has lost trust in code-only tests, so this spec deliberately:
 *   - asserts the DOM order of cards on Step 3 (vLLM card placement)
 *   - asserts there are NO role="switch" elements on Step 3 (no slide toggles)
 *   - asserts there IS a <input type="range"> on Step 5 (slider lives)
 *   - reads bratan.config.yaml from disk afterwards and confirms persistence
 *
 * Run with:
 *   npx playwright test --config wizard-walk-full.config.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "bratan.config.yaml");

interface BratanCfg {
  project: { project_name: string; corpus_path: string; seed_target_n: number };
  vector_db: { adapter: string; chroma_path: string; chroma_collection: string };
  models: {
    anthropic_api_key: string;
    oracle_model: string;
    use_local_embedding: boolean;
    use_local_reranker: boolean;
    use_local_prejudge: boolean;
  };
  cost: {
    usd_per_run: number;
    tokens_per_iteration: number;
    cache_ttl_hours: number;
    subset_eval_size: number;
  };
  stop: {
    convergence_threshold: number;
    convergence_window: number;
    max_iterations: number;
    anchor_regression_threshold: number;
    regression_policy: string;
  };
  judge_weights: { correctness: number; recall_at_5: number; faithfulness: number };
  setup_completed: boolean;
}

/**
 * Wait for a /api/setup/save-step POST for the given step to resolve, so we
 * know the debounced autosave has actually landed before clicking Next.
 */
async function awaitSaveStep(page: Page, step: number, timeout = 10_000): Promise<void> {
  await page
    .waitForResponse(
      (r) =>
        r.url().includes("/api/setup/save-step") &&
        r.request().method() === "POST" &&
        r.ok() &&
        (r.request().postDataJSON() as { step?: number } | null)?.step === step,
      { timeout },
    )
    .catch(() => {
      // Some steps (e.g. 6) save via a separate code path or not at all —
      // don't fail the test just because we didn't see the POST.
      console.log(`[verifier] no save-step POST seen for step ${step} within ${timeout}ms`);
    });
}

test.beforeAll(() => {
  // Hard reset all state the wizard can touch. Spawning via shell keeps the
  // assertion logic readable and matches how the user's harness wipes state.
  execSync(
    "rm -rf " +
      [
        path.join(PROJECT_ROOT, ".chroma"),
        path.join(PROJECT_ROOT, "bratan.config.yaml"),
        path.join(PROJECT_ROOT, ".bratan-setup.json"),
        path.join(PROJECT_ROOT, "test_cases", "seed.jsonl"),
        path.join(PROJECT_ROOT, "test_cases", ".drafts"),
      ]
        .map((p) => `'${p}'`)
        .join(" "),
    { stdio: "inherit" },
  );
});

test("wizard-walk: drives all 8 steps end-to-end and persists to YAML", async ({ page }) => {
  // Capture console errors throughout the run.
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  // ----- Navigate -----
  await test.step("redirect / -> /setup", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup(\/|$)/, { timeout: 15_000 });
    await expect(page.getByText(/Step 1 of 8/)).toBeVisible({ timeout: 15_000 });
  });

  // ===== Step 1 — Project basics =====
  await test.step("Step 1: project basics — name + corpus path persist", async () => {
    const name = page.getByLabel(/project name/i);
    await name.fill("verifier-walk");
    await expect(name).toHaveValue("verifier-walk");

    const corpus = page.getByLabel(/corpus path/i);
    await corpus.fill("./corpus");
    await expect(corpus).toHaveValue("./corpus");

    const save = awaitSaveStep(page, 1);
    await name.press("End"); // nudge debounced save
    await save;

    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 2 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 2 — Vector DB =====
  await test.step("Step 2: vector db — 6 radio cards render & switch", async () => {
    // The adapter cards are <button role="button" aria-pressed=...> tiles.
    // Each has a heading with the adapter's label. Count them by heading.
    for (const label of [
      /ChromaDB/i,
      /Qdrant/i,
      /Pinecone/i,
      /Weaviate/i,
      /pgvector/i,
      /Other \/ custom/i,
    ]) {
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
    }

    // Click each in turn; assert the per-adapter panel swaps.
    await page.getByRole("button", { name: /Qdrant/i }).click();
    await expect(page.getByLabel(/Qdrant URL/i)).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /Pinecone/i }).click();
    await expect(page.getByLabel(/Index name/i)).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /Weaviate/i }).click();
    await expect(page.getByLabel(/Weaviate URL/i)).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /pgvector/i }).click();
    await expect(page.getByLabel(/Postgres DSN/i)).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /Other \/ custom/i }).click();
    await expect(page.getByLabel(/Module path/i)).toBeVisible({ timeout: 5_000 });

    // Back to chroma.
    await page.getByRole("button", { name: /ChromaDB/i }).click();
    await expect(page.getByLabel(/Chroma path/i)).toBeVisible({ timeout: 5_000 });
  });

  await test.step("Step 2: chroma Test connection shows green/ok badge", async () => {
    await page.getByRole("button", { name: /Test connection/i }).click();
    // ConnectionBadge renders text — accept "Connected" or "OK"; fall back
    // to checking for the testMutation success state via colour class.
    const badge = page
      .getByText(/connected|reachable|ok\b/i)
      .or(page.locator('[data-state="ok"]'));
    await expect(badge.first()).toBeVisible({ timeout: 10_000 });
  });

  await test.step("Step 2: save & advance", async () => {
    // Fill chroma fields with deterministic values for the YAML assertion.
    await page.getByLabel(/Chroma path/i).fill("./.chroma");
    await page.getByLabel(/Collection name/i).fill("verifier-corpus");

    const save = awaitSaveStep(page, 2);
    await page.getByLabel(/Collection name/i).press("End");
    await save;
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 3 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 3 — Models =====
  await test.step("Step 3: NO role=switch elements (no slide-toggles)", async () => {
    const switches = page.locator('[role="switch"]');
    expect(await switches.count()).toBe(0);
  });

  await test.step("Step 3: 3 checkboxes for use_local_* and they toggle", async () => {
    // The three Toggle() components render <input type="checkbox">.
    const boxes = page.locator('input[type="checkbox"]');
    const count = await boxes.count();
    // We want at least the 3 documented ones; some pages may inject extras
    // but the Step 3 component itself produces exactly 3.
    expect(count).toBeGreaterThanOrEqual(3);

    // Each defaults to checked. Click each and assert state flips.
    for (let i = 0; i < 3; i++) {
      const cb = boxes.nth(i);
      const before = await cb.isChecked();
      await cb.click();
      const after = await cb.isChecked();
      expect(after).toBe(!before);
      // Re-check it so downstream YAML assertion sees use_local_* = true.
      if (!after) await cb.click();
      await expect(cb).toBeChecked();
    }
  });

  await test.step("Step 3: bad API key -> Anthropic Test renders friendly error (not raw JSON)", async () => {
    const apiKey = page.getByLabel(/API key/i).first();
    await apiKey.fill("sk-ant-bogus-verifier");
    // The Anthropic "Test" button is the secondary button in the API key row.
    await page.getByRole("button", { name: /^Test$/i }).first().click();
    // The friendly copy lives in explainAnthropicError() — match the common
    // mapped strings without locking to one exact wording.
    const errSpan = page.getByTestId("anthropic-error-message");
    await expect(errSpan).toBeVisible({ timeout: 15_000 });
    const text = (await errSpan.textContent()) ?? "";
    // Must NOT look like raw JSON or a stack trace.
    expect(text.trim().startsWith("{")).toBe(false);
    expect(text.toLowerCase()).toMatch(/invalid|unauthor|api key|key/);
  });

  await test.step('Step 3: "Get vLLM running" card sits ABOVE "Local vLLM endpoint" card', async () => {
    // Both Cards have h2/h3 titles. We compare bounding-box Y coordinates.
    const getVLLM = page.getByText(/Get vLLM running/i).first();
    const localVLLM = page.getByText(/Local vLLM endpoint/i).first();
    await expect(getVLLM).toBeVisible();
    await expect(localVLLM).toBeVisible();
    const aBox = await getVLLM.boundingBox();
    const bBox = await localVLLM.boundingBox();
    expect(aBox).not.toBeNull();
    expect(bBox).not.toBeNull();
    expect(aBox!.y).toBeLessThan(bBox!.y);
  });

  await test.step("Step 3: save & advance", async () => {
    const save = awaitSaveStep(page, 3);
    // Nudge to force a debounced save (api key was the last edit).
    await page.getByLabel(/Oracle model/i).press("End");
    await save;
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 4 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 4 — Cost ceilings =====
  await test.step("Step 4: numeric inputs accept & persist new values", async () => {
    const usd = page.getByLabel(/USD per run/i);
    await usd.fill("4.25");
    await expect(usd).toHaveValue("4.25");

    const tokens = page.getByLabel(/Tokens per iteration/i);
    await tokens.fill("1500000");
    await expect(tokens).toHaveValue("1500000");

    const ttl = page.getByLabel(/Cache TTL/i);
    await ttl.fill("72");
    await expect(ttl).toHaveValue("72");

    const subset = page.getByLabel(/Subset eval size/i);
    await subset.fill("15");
    await expect(subset).toHaveValue("15");

    const save = awaitSaveStep(page, 4);
    await subset.press("End");
    await save;
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 5 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 5 — Seed target N (THE slider regression check) =====
  await test.step("Step 5: <input type=range> slider exists and drags", async () => {
    const range = page.locator('input[type="range"]');
    const count = await range.count();
    expect(count).toBeGreaterThanOrEqual(1); // The seed_target_n slider.

    const slider = page.getByLabel(/Target number of seed cases/i);
    await expect(slider).toBeVisible();
    // Drag via .fill() which works on type=range in Playwright.
    await slider.fill("85");
    // Force a change event.
    await slider.press("ArrowLeft");
    await slider.press("ArrowRight");
    await expect(slider).toHaveValue("85");

    // NOTE: don't use .press("End") on a range input — End jumps to max.
    // ArrowLeft+ArrowRight has already fired the change event above; just wait.
    const save = awaitSaveStep(page, 5);
    await save;
    // Re-assert the persisted UI value didn't drift.
    await expect(slider).toHaveValue("85");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 6 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 6 — GPU detection =====
  await test.step("Step 6: GPU probe fires & banner shows", async () => {
    const banner = page.getByTestId("gpu-detection-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
  });

  await test.step("Step 6: left-nav marks step 6 completed (or active)", async () => {
    // The StepIndicator nav renders a Link per step. Find the row whose
    // visible text says "GPU" (step 6's STEP_TITLE) and check it has either
    // the "active" highlight (text-brand-700) or a checkmark sibling.
    const navLinks = page.locator('nav[aria-label="Setup steps"] a');
    const step6Link = navLinks.nth(5); // 0-indexed, step 6 = idx 5
    await expect(step6Link).toBeVisible();
    // The active step is current step; we're on step 6, so the visual state
    // we want to confirm is "currently selected" (text-brand-700) or "completed".
    const cls = (await step6Link.getAttribute("class")) ?? "";
    expect(cls).toMatch(/brand|emerald/i);
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 7 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 7 — Stopping criteria =====
  await test.step("Step 7: stopping-criteria inputs accept values + regression policy toggles", async () => {
    const conv = page.getByLabel(/Convergence threshold/i);
    await conv.fill("0.015");
    await expect(conv).toHaveValue("0.015");

    const win = page.getByLabel(/Convergence window/i);
    await win.fill("4");
    await expect(win).toHaveValue("4");

    const maxIt = page.getByLabel(/Max iterations/i);
    await maxIt.fill("33");
    await expect(maxIt).toHaveValue("33");

    const anchor = page.getByLabel(/Anchor regression threshold/i);
    await anchor.fill("0.25");
    await expect(anchor).toHaveValue("0.25");

    // Policy radios are buttons with aria-pressed.
    const warnBtn = page.getByRole("button", { name: /Warn \(continue\)/i });
    const blockBtn = page.getByRole("button", { name: /Block \(stop loop\)/i });
    await blockBtn.click();
    await expect(blockBtn).toHaveAttribute("aria-pressed", "true");
    await warnBtn.click();
    await expect(warnBtn).toHaveAttribute("aria-pressed", "true");
    // Leave on "block" for the YAML assertion at the end.
    await blockBtn.click();
    await expect(blockBtn).toHaveAttribute("aria-pressed", "true");

    const save = awaitSaveStep(page, 7);
    await maxIt.press("End");
    await save;
    await page.getByTestId("wizard-next").click();
    await expect(page.getByText(/Step 8 of 8/)).toBeVisible({ timeout: 10_000 });
  });

  // ===== Step 8 — Judge weights =====
  await test.step("Step 8: 3 judge-weight sliders + unbalanced-sum warning fires", async () => {
    const ranges = page.locator('input[type="range"]');
    expect(await ranges.count()).toBe(3);

    const correctness = page.getByLabel(/^Correctness$/i);
    const recall = page.getByLabel(/Recall @ 5/i);
    const faithfulness = page.getByLabel(/Faithfulness/i);

    // Make weights deliberately unbalanced (sum != 1) — warning should appear.
    await correctness.fill("0.7");
    await recall.fill("0.4");
    await faithfulness.fill("0.4");
    await faithfulness.press("ArrowLeft");
    await faithfulness.press("ArrowRight");
    // Sum is ~1.5 -> warning copy mentions "should sum to 1.00".
    await expect(page.getByText(/should sum to 1\.00/i)).toBeVisible({ timeout: 5_000 });

    // Now bring them back to a valid set (0.5 / 0.25 / 0.25) so the YAML
    // file ends up with a sane composite.
    await correctness.fill("0.5");
    await recall.fill("0.25");
    await faithfulness.fill("0.25");
    await faithfulness.press("ArrowLeft");
    await faithfulness.press("ArrowRight");
    await expect(page.getByText(/\(valid\)/i)).toBeVisible({ timeout: 5_000 });

    // NOTE: don't .press("End") on a range — End == max. Arrow-nudge above
    // already fired the change; just wait for the save to land.
    const save = awaitSaveStep(page, 8);
    await save;
    await expect(faithfulness).toHaveValue("0.25");
  });

  // ===== Finish -> /authoring =====
  await test.step("Finish -> redirect to /authoring", async () => {
    await page.getByTestId("wizard-next").click();
    await expect(page).toHaveURL(/\/authoring/, { timeout: 15_000 });
  });

  // ===== Read YAML & assert persistence =====
  await test.step("bratan.config.yaml exists and reflects every wizard choice", async () => {
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    const text = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = yaml.load(text) as BratanCfg;

    expect(cfg.project.project_name).toBe("verifier-walk");
    expect(cfg.project.corpus_path).toBe("./corpus");
    expect(cfg.project.seed_target_n).toBe(85);

    expect(cfg.vector_db.adapter).toBe("chroma");
    expect(cfg.vector_db.chroma_path).toBe("./.chroma");
    expect(cfg.vector_db.chroma_collection).toBe("verifier-corpus");

    expect(cfg.models.anthropic_api_key).toBe("sk-ant-bogus-verifier");
    expect(cfg.models.use_local_embedding).toBe(true);
    expect(cfg.models.use_local_reranker).toBe(true);
    expect(cfg.models.use_local_prejudge).toBe(true);

    expect(cfg.cost.usd_per_run).toBeCloseTo(4.25, 5);
    expect(cfg.cost.tokens_per_iteration).toBe(1_500_000);
    expect(cfg.cost.cache_ttl_hours).toBe(72);
    expect(cfg.cost.subset_eval_size).toBe(15);

    expect(cfg.stop.convergence_threshold).toBeCloseTo(0.015, 5);
    expect(cfg.stop.convergence_window).toBe(4);
    expect(cfg.stop.max_iterations).toBe(33);
    expect(cfg.stop.anchor_regression_threshold).toBeCloseTo(0.25, 5);
    expect(cfg.stop.regression_policy).toBe("block");

    expect(cfg.judge_weights.correctness).toBeCloseTo(0.5, 5);
    expect(cfg.judge_weights.recall_at_5).toBeCloseTo(0.25, 5);
    expect(cfg.judge_weights.faithfulness).toBeCloseTo(0.25, 5);

    expect(cfg.setup_completed).toBe(true);
  });

  // ===== Side test: from-corpus boxes editable =====
  await test.step("Authoring: from-corpus mode is default tab", async () => {
    // The mode toggle exposes two role=tab buttons.
    const fromCorpusTab = page.getByRole("tab", { name: /From the corpus/i });
    await expect(fromCorpusTab).toBeVisible({ timeout: 10_000 });
    expect(await fromCorpusTab.getAttribute("aria-selected")).toBe("true");
  });

  await test.step("Authoring: click first file then first passage, textareas editable", async () => {
    const fileBtn = page.getByTestId("from-corpus-file").first();
    await expect(fileBtn).toBeVisible({ timeout: 15_000 });
    await fileBtn.click();

    const passageList = page.getByTestId("from-corpus-passage-list");
    await expect(passageList).toBeVisible({ timeout: 25_000 });
    const firstPassage = page.getByTestId("from-corpus-passage").first();
    await expect(firstPassage).toBeVisible({ timeout: 15_000 });
    await firstPassage.click();

    // After click: anchored-passage banner appears, textareas unlock.
    await expect(page.getByTestId("anchored-passage")).toBeVisible({ timeout: 10_000 });

    // Field labels include a required-asterisk span, so the accessible name
    // becomes e.g. "Question *". Match with a permissive prefix regex (same
    // approach as verify-from-corpus.spec.ts).
    const question = page.getByLabel(/^Question/i).first();
    const ground = page.getByLabel(/Ground-truth/i).first();
    await expect(question).toBeVisible({ timeout: 10_000 });
    await expect(ground).toBeVisible({ timeout: 10_000 });

    // Neither should be disabled.
    expect(await question.isDisabled()).toBe(false);
    expect(await ground.isDisabled()).toBe(false);

    const Q = "Verifier: does the corpus say something?";
    const GT = "Verifier ground-truth — typed by spec.";
    await question.fill(Q);
    await ground.fill(GT);
    await expect(question).toHaveValue(Q);
    await expect(ground).toHaveValue(GT);
  });

  if (consoleErrors.length > 0) {
    console.log("[verifier] console errors during run:\n" + consoleErrors.join("\n"));
  }
});

// ---------------------------------------------------------------------------
// Row 9 — Step 3 -> Step 6 VRAM cascade
//
// Toggling `use_local_embedding=false` in Step 3 must cause the embedding row
// to vanish from the Step 6 VRAM breakdown AND the total MB to drop by the
// embedding model's footprint (BG-small = 130 MB; see VRAM_TABLE in
// Step6GPU.tsx). The unit test catches this at the component level; this
// proves the cascade at the full-flow level (Step3Models writes to config,
// useConfig refetches, Step6GPU re-renders the breakdown).
// ---------------------------------------------------------------------------
test("Step 3 -> Step 6: toggling use_local_embedding=false drops embedding row from VRAM breakdown", async ({
  page,
}) => {
  resetBratanState();

  await page.goto("/");
  await expect(page.getByText(/Step 1 of 8/)).toBeVisible({ timeout: 15_000 });

  // Step 1 — minimal: just fill required fields and advance.
  await page.getByLabel(/project name/i).fill("cascade-walk");
  await page.getByLabel(/corpus path/i).fill("./corpus");
  const save1 = awaitSaveStep(page, 1);
  await page.getByLabel(/project name/i).press("End");
  await save1;
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 2 of 8/)).toBeVisible({ timeout: 10_000 });

  // Step 2 — accept chroma defaults and advance.
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 3 of 8/)).toBeVisible({ timeout: 10_000 });

  // Step 3 — uncheck the first checkbox (Local embedding). The three Toggles
  // render input[type=checkbox] in DOM order: embedding, reranker, prejudge.
  const checkboxes = page.locator('input[type="checkbox"]');
  const embeddingCb = checkboxes.nth(0);
  await expect(embeddingCb).toBeChecked();

  // Register the save-step listener BEFORE the click so we don't miss the
  // debounced POST. Then click, nudge, await.
  const save3 = awaitSaveStep(page, 3);
  await embeddingCb.click();
  await expect(embeddingCb).not.toBeChecked();
  await page.getByLabel(/Oracle model/i).press("End");
  await save3;

  // Advance: Step 4, Step 5 -> Step 6.
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 4 of 8/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 5 of 8/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 6 of 8/)).toBeVisible({ timeout: 10_000 });

  // Wait for the GPU probe + breakdown card to render.
  await expect(page.getByTestId("vram-breakdown")).toBeVisible({ timeout: 20_000 });

  // The embedding row must NOT be present; reranker + prejudge stay.
  await expect(page.getByTestId("vram-row-embedding")).toHaveCount(0);
  await expect(page.getByTestId("vram-row-reranker")).toBeVisible();
  await expect(page.getByTestId("vram-row-prejudge")).toBeVisible();

  // Total MB must equal reranker (2300) + prejudge (5000) = 7300 with the
  // default model selections (bge-reranker-v2-m3 + Qwen2.5-7B-Instruct-AWQ).
  // We don't lock the exact figure in case the VRAM_TABLE shifts; instead we
  // assert the parsed total is strictly less than the all-on baseline of
  // 7430 MB (which would include the +130 MB BG-small embedding).
  const totalText = (await page.getByTestId("vram-total-mb").textContent()) ?? "";
  const totalMb = parseInt(totalText.replace(/[^\d]/g, ""), 10);
  expect(Number.isFinite(totalMb)).toBe(true);
  expect(totalMb).toBeGreaterThan(0);
  expect(totalMb).toBeLessThan(7430);
  // And the per-row sum must match the displayed total.
  const rerankerText =
    (await page.getByTestId("vram-mb-reranker").textContent()) ?? "";
  const prejudgeText =
    (await page.getByTestId("vram-mb-prejudge").textContent()) ?? "";
  const sum =
    parseInt(rerankerText.replace(/[^\d]/g, ""), 10) +
    parseInt(prejudgeText.replace(/[^\d]/g, ""), 10);
  expect(totalMb).toBe(sum);
});

// ---------------------------------------------------------------------------
// Row 15 — Step 2 non-chroma persistence (Pinecone has the most fields)
//
// Switching the adapter to Pinecone and filling all five Pinecone fields must
// round-trip through Pydantic to bratan.config.yaml. The unit actuation tests
// confirm the payload SHAPE; only e2e + YAML readback confirms the backend
// actually persists every non-chroma field.
// ---------------------------------------------------------------------------
interface PineconeVectorDb {
  adapter: string;
  pinecone_api_key: string | null;
  pinecone_index: string | null;
  pinecone_cloud: string;
  pinecone_region: string;
  pinecone_namespace: string;
}

test("Step 2 -> Finish: Pinecone adapter persists all 5 fields to bratan.config.yaml", async ({
  page,
}) => {
  resetBratanState();

  await page.goto("/");
  await expect(page.getByText(/Step 1 of 8/)).toBeVisible({ timeout: 15_000 });

  // Step 1 — minimal.
  await page.getByLabel(/project name/i).fill("pinecone-walk");
  await page.getByLabel(/corpus path/i).fill("./corpus");
  const save1 = awaitSaveStep(page, 1);
  await page.getByLabel(/project name/i).press("End");
  await save1;
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 2 of 8/)).toBeVisible({ timeout: 10_000 });

  // Step 2 — switch to Pinecone, fill all 5 fields.
  await page.getByRole("button", { name: /Pinecone/i }).click();
  await expect(page.getByLabel(/Index name/i)).toBeVisible({ timeout: 5_000 });

  const apiKey = page.getByLabel(/^API key$/i);
  const indexName = page.getByLabel(/Index name/i);
  const cloud = page.getByLabel(/^Cloud$/i);
  const region = page.getByLabel(/^Region$/i);
  const namespace = page.getByLabel(/^Namespace$/i);

  await apiKey.fill("pcsk-e2e-verifier-fake");
  await indexName.fill("bratan-e2e-index");
  await cloud.fill("gcp");
  await region.fill("us-central1");
  await namespace.fill("verifier-ns");

  const save2 = awaitSaveStep(page, 2);
  await namespace.press("End");
  await save2;
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 3 of 8/)).toBeVisible({ timeout: 10_000 });

  // Step 3 — minimal API key so the wizard treats step 3 as saved.
  await page.getByLabel(/API key/i).first().fill("sk-ant-pinecone-fake");
  const save3 = awaitSaveStep(page, 3);
  await page.getByLabel(/Oracle model/i).press("End");
  await save3;
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 4 of 8/)).toBeVisible({ timeout: 10_000 });

  // Steps 4, 5, 6, 7 — accept defaults; just advance.
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 5 of 8/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 6 of 8/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 7 of 8/)).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("wizard-next").click();
  await expect(page.getByText(/Step 8 of 8/)).toBeVisible({ timeout: 10_000 });

  // Step 8 — Finish.
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/authoring/, { timeout: 15_000 });

  // Readback: bratan.config.yaml must reflect every Pinecone field.
  expect(fs.existsSync(CONFIG_PATH)).toBe(true);
  const text = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg = yaml.load(text) as { vector_db: PineconeVectorDb };

  expect(cfg.vector_db.adapter).toBe("pinecone");
  expect(cfg.vector_db.pinecone_api_key).toBe("pcsk-e2e-verifier-fake");
  expect(cfg.vector_db.pinecone_index).toBe("bratan-e2e-index");
  expect(cfg.vector_db.pinecone_cloud).toBe("gcp");
  expect(cfg.vector_db.pinecone_region).toBe("us-central1");
  expect(cfg.vector_db.pinecone_namespace).toBe("verifier-ns");
});
