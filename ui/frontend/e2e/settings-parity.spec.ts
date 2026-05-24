import { test, expect, type Page } from "@playwright/test";

/**
 * Settings-page parity verifier for dev/round-5.
 *
 * Asserts the Settings page mirrors the wizard surface after round-5 changes:
 *  - Step 3 slide-toggles became plain checkboxes (no role="switch" anywhere)
 *  - Step 5 / Step 8 sliders restored
 *  - Each field still autosaves via PATCH and shows up in GET /api/config
 *
 * Targets the live Vite dev server on :5173 (not preview :4173). Pair with a
 * config that has no webServer block, OR rely on reuseExistingServer.
 */

test.use({ baseURL: "http://127.0.0.1:5173" });

const API = "http://127.0.0.1:8000";

interface BratanConfig {
  project: { project_name: string; corpus_path: string; seed_target_n: number };
  models: {
    use_local_embedding: boolean;
    use_local_reranker: boolean;
    use_local_prejudge: boolean;
    [k: string]: unknown;
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
  setup_completed?: boolean;
}

async function fetchConfig(page: Page): Promise<BratanConfig> {
  const resp = await page.request.get(`${API}/api/config`);
  if (!resp.ok()) {
    throw new Error(`GET /api/config failed: ${resp.status()} ${await resp.text()}`);
  }
  return (await resp.json()) as BratanConfig;
}

async function ensureBootstrap(page: Page): Promise<void> {
  // If bratan.config.yaml doesn't exist yet, bootstrap a minimal one so the
  // Settings page actually renders fields with values.
  const cfgResp = await page.request.get(`${API}/api/config`);
  if (cfgResp.ok()) {
    const body = (await cfgResp.json()) as BratanConfig & { setup_completed?: boolean };
    if (body?.setup_completed) return;
  }
  await page.request.post(`${API}/api/setup/save-step`, {
    data: {
      step: 1,
      data: {
        project: {
          project_name: "settings-verifier",
          corpus_path: "./corpus",
          seed_target_n: 50,
        },
      },
    },
  });
  await page.request.post(`${API}/api/setup/finish`);
}

/** Wait for an autosave POST that targets `step` to land and succeed. */
async function expectSaveStep(page: Page, step: number): Promise<void> {
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/setup/save-step") &&
      r.request().method() === "POST" &&
      r.ok() &&
      (r.request().postDataJSON() as { step?: number } | null)?.step === step,
    { timeout: 10_000 },
  );
}

test("Settings mirrors the wizard surface and persists per field", async ({ page }) => {
  await ensureBootstrap(page);

  await page.goto("/settings");

  // ---- Sidebar nav assertion: every wizard section is present.
  // Settings sidebar labels (from Settings.tsx): Project, Vector DB, Models,
  // Cost ceilings, Seed target, GPU, Stopping criteria, Judge weights.
  for (const label of [
    "Project",
    "Vector DB",
    "Models",
    "Cost ceilings",
    "Seed target",
    "GPU",
    "Stopping criteria",
    "Judge weights",
  ]) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }),
    ).toBeVisible();
  }

  // ---- 1) project.project_name persistence (Step 1 surface).
  await page.getByRole("button", { name: /^project$/i }).click();
  const nameInput = page.getByLabel(/project name/i);
  await expect(nameInput).toBeVisible();
  const newName = `parity-${Date.now()}`;
  await nameInput.fill(newName);
  // Trailing nudge so the debounced save fires for sure.
  const save1 = expectSaveStep(page, 1);
  await nameInput.press("End");
  await save1;
  // Allow the round-trip to settle so GET /api/config returns the fresh row.
  const cfgAfterName = await fetchConfig(page);
  expect(cfgAfterName.project.project_name).toBe(newName);

  // ---- 2) project.seed_target_n via slider (Step 5 surface).
  await page.getByRole("button", { name: /^seed target$/i }).click();
  const seedSlider = page.getByTestId("slider-target-number-of-seed-cases");
  await expect(seedSlider).toBeVisible();
  // The Slider must be a native <input type="range"> — assert that, so this
  // test fails loudly if someone swaps in a non-range custom widget.
  await expect(seedSlider).toHaveAttribute("type", "range");
  await seedSlider.fill("85");
  const save5 = expectSaveStep(page, 5);
  await seedSlider.press("ArrowLeft");
  await seedSlider.press("ArrowRight");
  await save5;
  await expect(seedSlider).toHaveValue("85");
  const cfgAfterSeed = await fetchConfig(page);
  expect(cfgAfterSeed.project.seed_target_n).toBe(85);

  // ---- 3) models.use_local_* via checkbox (Step 3 surface) — must be a
  // real <input type="checkbox">, not a role="switch" slide-toggle.
  await page.getByRole("button", { name: /^models$/i }).click();
  const embeddingCb = page.getByRole("checkbox", { name: /local embedding/i });
  await expect(embeddingCb).toBeVisible();
  // The DOM-level element type must be a checkbox input.
  const tagInfo = await embeddingCb.evaluate((el) => ({
    tag: el.tagName,
    type: (el as HTMLInputElement).type,
    role: el.getAttribute("role"),
  }));
  expect(tagInfo.tag).toBe("INPUT");
  expect(tagInfo.type).toBe("checkbox");
  // Roles "switch" must NEVER be present on Step 3's toggles.
  expect(tagInfo.role).not.toBe("switch");
  const before = await embeddingCb.isChecked();
  await embeddingCb.click();
  const save3 = expectSaveStep(page, 3);
  await save3;
  await expect(embeddingCb).toBeChecked({ checked: !before });
  const cfgAfterModels = await fetchConfig(page);
  expect(cfgAfterModels.models.use_local_embedding).toBe(!before);

  // ---- 4) cost.* via number input (Step 4 surface).
  await page.getByRole("button", { name: /^cost ceilings$/i }).click();
  const usd = page.getByLabel(/usd per run/i);
  await expect(usd).toBeVisible();
  await usd.fill("7.5");
  const save4 = expectSaveStep(page, 4);
  await usd.press("End");
  await save4;
  const cfgAfterCost = await fetchConfig(page);
  expect(cfgAfterCost.cost.usd_per_run).toBe(7.5);

  // ---- 5) judge_weights.* via slider (Step 8 surface).
  await page.getByRole("button", { name: /^judge weights$/i }).click();
  const corrSlider = page.getByTestId("slider-correctness");
  await expect(corrSlider).toBeVisible();
  await expect(corrSlider).toHaveAttribute("type", "range");
  await corrSlider.fill("0.55");
  const save8 = expectSaveStep(page, 8);
  await corrSlider.press("ArrowLeft");
  await corrSlider.press("ArrowRight");
  await save8;
  const cfgAfterJudge = await fetchConfig(page);
  expect(cfgAfterJudge.judge_weights.correctness).toBeCloseTo(0.55, 5);

  // ---- 6) stop.* via number input (Step 7 surface).
  await page.getByRole("button", { name: /^stopping criteria$/i }).click();
  const maxIter = page.getByLabel(/max iterations/i);
  await expect(maxIter).toBeVisible();
  await maxIter.fill("33");
  const save7 = expectSaveStep(page, 7);
  await maxIter.press("End");
  await save7;
  const cfgAfterStop = await fetchConfig(page);
  expect(cfgAfterStop.stop.max_iterations).toBe(33);

  // ---- Hard parity assertion: NO role="switch" anywhere on Settings.
  // Walk every section so each is mounted at least once.
  for (const label of [
    "Project",
    "Vector DB",
    "Models",
    "Cost ceilings",
    "Seed target",
    "GPU",
    "Stopping criteria",
    "Judge weights",
  ]) {
    await page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).click();
    const switchCount = await page.locator('[role="switch"]').count();
    expect(switchCount, `role="switch" found while viewing ${label}`).toBe(0);
  }
});
