import { test, expect, type Page } from "@playwright/test";
import { readBratanConfig, resetBratanState } from "./helpers";

/**
 * Drive the full 8-step setup wizard in a real browser, then read
 * `bratan.config.yaml` and assert every field matches what was clicked.
 *
 * This test would catch the regression where `useAutoSaveStep` posted
 * unwrapped step data to /api/setup/save-step — Pydantic's `extra=ignore`
 * silently dropped every field, but the existing unit tests passed because
 * they posted the wrapped shape directly.
 */

/** Wait for a `/api/setup/save-step` POST to land, then resolve. */
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

test.beforeEach(async () => {
  resetBratanState();
});

test("full wizard persists user choices to bratan.config.yaml", async ({ page }) => {
  // ----- Step 1 — Project basics -----
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByText(/Step 1 of 8/)).toBeVisible();

  // Default value is "bratan"; replace it.
  const projectName = page.getByLabel(/project name/i);
  await projectName.fill("e2e-test");
  await expect(projectName).toHaveValue("e2e-test");

  const corpusPath = page.getByLabel(/corpus path/i);
  await corpusPath.fill("./corpus");

  const save1 = expectSaveStep(page, 1);
  // Type one more char then back to force a save with debounced trailing edit.
  await projectName.press("End");
  await save1;
  await page.getByTestId("wizard-next").click();

  // ----- Step 2 — Vector DB (default chroma) -----
  await expect(page.getByText(/Step 2 of 8/)).toBeVisible();
  const chromaPath = page.getByLabel(/chroma path/i);
  await chromaPath.fill("./.chroma");
  const collectionName = page.getByLabel(/collection name/i);
  await collectionName.fill("e2e-corpus");
  const save2 = expectSaveStep(page, 2);
  await collectionName.press("End");
  await save2;
  await page.getByTestId("wizard-next").click();

  // ----- Step 3 — Models -----
  await expect(page.getByText(/Step 3 of 8/)).toBeVisible();
  const apiKey = page.getByLabel(/api key/i).first();
  await apiKey.fill("sk-ant-e2e-fake");
  const oracleModel = page.getByLabel(/oracle model/i);
  await oracleModel.fill("claude-sonnet-4-6");
  const save3 = expectSaveStep(page, 3);
  await oracleModel.press("End");
  await save3;
  await page.getByTestId("wizard-next").click();

  // ----- Step 4 — Costs -----
  await expect(page.getByText(/Step 4 of 8/)).toBeVisible();
  const usd = page.getByLabel(/usd per run/i);
  await usd.fill("3.5");
  const subsetEval = page.getByLabel(/subset eval size/i);
  await subsetEval.fill("12");
  const save4 = expectSaveStep(page, 4);
  await subsetEval.press("End");
  await save4;
  await page.getByTestId("wizard-next").click();

  // ----- Step 5 — Seed target N (slider) -----
  await expect(page.getByText(/Step 5 of 8/)).toBeVisible();
  const seedSlider = page.getByLabel(/target number of seed cases/i);
  // Sliders are range inputs; .fill() works on type=range.
  await seedSlider.fill("75");
  const save5 = expectSaveStep(page, 5);
  // Nudge to ensure a change event fires after fill.
  await seedSlider.press("ArrowLeft");
  await seedSlider.press("ArrowRight");
  await save5;
  await expect(seedSlider).toHaveValue("75");
  await page.getByTestId("wizard-next").click();

  // ----- Step 6 — GPU (no persistence; just advance) -----
  await expect(page.getByText(/Step 6 of 8/)).toBeVisible();
  await page.getByTestId("wizard-next").click();

  // ----- Step 7 — Stopping criteria -----
  await expect(page.getByText(/Step 7 of 8/)).toBeVisible();
  const maxIter = page.getByLabel(/max iterations/i);
  await maxIter.fill("42");
  // Pick "Block (stop loop)" — aria-pressed makes role=button work.
  await page.getByRole("button", { name: /block \(stop loop\)/i }).click();
  const save7 = expectSaveStep(page, 7);
  await maxIter.press("End");
  await save7;
  await page.getByTestId("wizard-next").click();

  // ----- Step 8 — Judge weights -----
  await expect(page.getByText(/Step 8 of 8/)).toBeVisible();
  const correctness = page.getByLabel(/^correctness$/i);
  const recall = page.getByLabel(/recall @ 5/i);
  const faith = page.getByLabel(/faithfulness/i);
  // Defaults are 0.4 / 0.3 / 0.3. Set 0.5 / 0.25 / 0.25 so all three differ.
  await correctness.fill("0.5");
  await recall.fill("0.25");
  await faith.fill("0.25");
  const save8 = expectSaveStep(page, 8);
  await faith.press("ArrowLeft");
  await faith.press("ArrowRight");
  await save8;

  // ----- Finish -----
  await page.getByTestId("wizard-next").click();
  await expect(page).toHaveURL(/\/authoring/, { timeout: 15_000 });

  // ----- Assertions against the persisted YAML -----
  const cfg = readBratanConfig();

  expect(cfg.project.project_name).toBe("e2e-test");
  expect(cfg.project.corpus_path).toBe("./corpus");
  expect(cfg.project.seed_target_n).toBe(75);

  expect(cfg.vector_db.adapter).toBe("chroma");
  expect(cfg.vector_db.chroma_path).toBe("./.chroma");
  expect(cfg.vector_db.chroma_collection).toBe("e2e-corpus");

  expect(cfg.models.anthropic_api_key).toBe("sk-ant-e2e-fake");
  expect(cfg.models.oracle_model).toBe("claude-sonnet-4-6");

  expect(cfg.cost.usd_per_run).toBe(3.5);
  expect(cfg.cost.subset_eval_size).toBe(12);

  expect(cfg.stop.max_iterations).toBe(42);
  expect(cfg.stop.regression_policy).toBe("block");

  expect(cfg.judge_weights.correctness).toBeCloseTo(0.5, 5);
  expect(cfg.judge_weights.recall_at_5).toBeCloseTo(0.25, 5);
  expect(cfg.judge_weights.faithfulness).toBeCloseTo(0.25, 5);

  expect(cfg.setup_completed).toBe(true);
});
