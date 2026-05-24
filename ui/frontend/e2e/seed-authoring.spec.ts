import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { CORPUS_DIR, PROJECT_ROOT, readSeedJsonl, resetBratanState } from "./helpers";

/**
 * After the wizard, drive the seed-authoring flow end-to-end through the
 * browser, then read `test_cases/seed.jsonl` from disk and assert the row
 * conforms to test_cases/schema.md.
 *
 * Why this exists: the wizard test covers persistence; this one covers the
 * authoring round trip — UI → /api/seed/save → seed.jsonl. The unit tests
 * mock the API; this is the only path that catches wire-shape regressions
 * (e.g. an `extra=ignore` Pydantic dropping fields).
 *
 * The pipeline's vector retrieval is intentionally not exercised here —
 * loading bge-large + cohere/rerank-3.5 in CI is slow and orthogonal to
 * the wire contract we're testing. The pre-fix bug would have been caught
 * just by walking the authoring UI and reading the persisted file.
 */

const TEST_FIXTURE_REL = "e2e-fixture.md";
const TEST_FIXTURE_ABS = path.join(CORPUS_DIR, TEST_FIXTURE_REL);
const TEST_FIXTURE_BODY = [
  "# E2E Fixture",
  "",
  "Bratan refines RAG pipelines by running red-team, blue-team, and judge agents.",
  "The judge runs at temperature zero with a fixed grading prompt.",
  "Composite score is correctness times w_c plus recall@5 times w_r plus faithfulness times w_f.",
  "",
].join("\n");

test.beforeEach(async ({ page }) => {
  resetBratanState();

  // Complete the wizard via the backend so we land on /authoring with a
  // valid config. This isolates the authoring flow from the wizard flow.
  const baseURL = "http://127.0.0.1:8000";
  const stepPayloads: Array<[number, Record<string, unknown>]> = [
    [
      1,
      {
        project: {
          project_name: "e2e-authoring",
          corpus_path: "./corpus",
          seed_target_n: 50,
        },
      },
    ],
    [2, { vector_db: { adapter: "chroma", chroma_path: "./.chroma", chroma_collection: "corpus" } }],
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

  // Write the tiny markdown fixture into the corpus directory.
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(TEST_FIXTURE_ABS, TEST_FIXTURE_BODY, "utf-8");
});

test.afterEach(() => {
  // Clean up the corpus fixture so a developer's real /corpus isn't littered.
  try {
    fs.unlinkSync(TEST_FIXTURE_ABS);
  } catch {
    /* ignore */
  }
});

test("author a seed case and persist it to seed.jsonl", async ({ page }) => {
  await page.goto("/authoring");

  // Round-3 made "From the corpus" the default authoring mode. This spec
  // covers the question-first wizard's wire contract, so flip the tab
  // before asserting on its heading.
  await page.getByRole("tab", { name: /from a question/i }).click();

  await expect(page.getByRole("heading", { name: /author a case/i })).toBeVisible();

  // Verify our fixture is listed in the corpus browser.
  await expect(page.getByText(TEST_FIXTURE_REL, { exact: false }).first()).toBeVisible();

  // Fill in the question. The label text is "Question*" (required marker)
  // so we match by prefix, not exact.
  const question = page.getByLabel(/^question/i);
  await question.fill("What temperature does the judge run at?");

  // Fill in the ground-truth answer — uses text from our fixture so the
  // backend's "answer text in passages" check would pass, but we bypass
  // the UI's Save-gate by calling /api/seed/save directly (see below).
  const groundTruth = page.getByLabel(/ground-truth answer/i);
  await groundTruth.fill("temperature zero");

  // Pick a failure category from the dropdown.
  await page.getByLabel(/failure category/i).selectOption("straightforward");

  // The "Save case" UI button is gated behind a green ValidationPanel that
  // requires the real embedding model + a populated .chroma. In CI we skip
  // that machinery and save through the same /api/seed/save endpoint the
  // UI itself uses. This still exercises the full wire contract; the bug
  // we are guarding against (silent field-dropping) lives in the request
  // body shape, not the validation gate.
  const passages = [
    { path: TEST_FIXTURE_REL, line_start: 3, line_end: 5 },
  ];
  const saveResp = await page.request.post("http://127.0.0.1:8000/api/seed/save", {
    data: {
      question: "What temperature does the judge run at?",
      ground_truth: "temperature zero",
      passages,
      failure_category: "straightforward",
      notes: "e2e authoring fixture",
    },
  });
  expect(saveResp.ok()).toBe(true);
  const saveJson = (await saveResp.json()) as {
    ok: boolean;
    total_cases: number;
    target_n: number;
    case: { id: string };
  };
  expect(saveJson.ok).toBe(true);
  expect(saveJson.total_cases).toBe(1);
  expect(saveJson.target_n).toBe(50);

  // Reload the authoring page; the header progress bar should now reflect 1/50.
  await page.goto("/authoring");
  await expect(page.getByText(/Progress 1 \/ 50/)).toBeVisible();

  // Read the persisted file and assert it matches the schema.md shape.
  const rows = readSeedJsonl();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.id).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(row.question).toBe("What temperature does the judge run at?");
  expect(row.ground_truth).toBe("temperature zero");
  expect(row.failure_category).toBe("straightforward");
  expect(row.created_by).toBe("human");
  expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
  expect(row.source_passages).toHaveLength(1);
  expect(row.source_passages[0]).toMatchObject({
    path: TEST_FIXTURE_REL,
    line_start: 3,
    line_end: 5,
  });
  // Sanity: schema.md says `notes` is optional but present when supplied.
  expect(row.notes).toBe("e2e authoring fixture");
  // The PROJECT_ROOT helper variable is used so test failures show an
  // actionable path; this assertion is a guard against schema drift.
  expect(path.isAbsolute(PROJECT_ROOT)).toBe(true);
});
