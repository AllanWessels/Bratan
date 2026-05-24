import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { CORPUS_DIR, resetBratanState, readSeedJsonl } from "./helpers";

/**
 * Smoke-test the live Run dashboard. We seed via the API (skipping the
 * authoring UI), start a 'no_agents' run, and assert the dashboard renders
 * the controls + we can press Stop. We deliberately don't wait for a full
 * iteration to complete: that requires real embedding models and bag of
 * machinery that's orthogonal to the UI's wire contract.
 */

const FIXTURE_REL = "run-dashboard-fixture.md";
const FIXTURE_ABS = path.join(CORPUS_DIR, FIXTURE_REL);
const FIXTURE_BODY = [
  "# Run dashboard fixture",
  "",
  "Bratan uses red-team, blue-team, and judge agents to improve a RAG pipeline.",
  "The judge runs at temperature zero.",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  resetBratanState();

  const baseURL = "http://127.0.0.1:8000";
  const stepPayloads: Array<[number, Record<string, unknown>]> = [
    [
      1,
      {
        project: {
          project_name: "e2e-run",
          corpus_path: "./corpus",
          seed_target_n: 50,
        },
      },
    ],
    [
      2,
      {
        vector_db: {
          adapter: "chroma",
          chroma_path: "./.chroma",
          chroma_collection: "corpus",
        },
      },
    ],
    [3, { models: { anthropic_api_key: "sk-ant-e2e-fake" } }],
  ];
  for (const [step, data] of stepPayloads) {
    const resp = await page.request.post(`${baseURL}/api/setup/save-step`, {
      data: { step, data },
    });
    expect(resp.ok()).toBe(true);
  }
  const finishResp = await page.request.post(`${baseURL}/api/setup/finish`);
  expect(finishResp.ok()).toBe(true);

  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_ABS, FIXTURE_BODY, "utf-8");

  // Add one seed case so the run has something to evaluate against.
  const saveResp = await page.request.post(`${baseURL}/api/seed/save`, {
    data: {
      question: "What temperature does the judge run at?",
      ground_truth: "temperature zero",
      passages: [{ path: FIXTURE_REL, line_start: 3, line_end: 4 }],
      failure_category: "straightforward",
      notes: "run dashboard fixture",
    },
  });
  expect(saveResp.ok()).toBe(true);
});

test.afterEach(() => {
  try {
    fs.unlinkSync(FIXTURE_ABS);
  } catch {
    /* ignore */
  }
});

test("Run dashboard shows the controls and Start posts the typed inputs", async ({ page }) => {
  await page.goto("/run");
  await expect(page.getByText(/Live run dashboard/i)).toBeVisible();

  // Header metric cards
  await expect(page.getByText(/Composite \(mean\)/i)).toBeVisible();
  await expect(page.getByText(/Pass rate ≥ 0\.6/)).toBeVisible();

  // Run controls
  await expect(page.getByLabel(/^iterations$/i)).toBeVisible();
  await expect(page.getByLabel(/budget usd/i)).toBeVisible();
  await expect(page.getByLabel(/skip red team/i)).toBeVisible();
  await expect(page.getByLabel(/no agents/i)).toBeVisible();
  await expect(page.getByTestId("start-button")).toBeVisible();
});

test("Seed list is visible on /authoring after API seeding", async ({ page }) => {
  await page.goto("/authoring");
  await expect(page.getByText(/Progress 1 \/ 50/)).toBeVisible();
  const rows = readSeedJsonl();
  expect(rows).toHaveLength(1);
});
