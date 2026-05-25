import { test, expect } from "@playwright/test";

/**
 * Ad-hoc verifier for the "From the corpus" authoring flow.
 *
 * This spec targets the live Vite dev server on http://127.0.0.1:5173 (not the
 * preview server on 4173 that the default playwright.config.ts spins up). Run
 * via the sibling verify-from-corpus.config.ts to avoid auto-spawning servers.
 */

test.use({ baseURL: "http://127.0.0.1:5173" });

// Ad-hoc verifier: requires a vite dev server on 5173 that the default
// playwright.config.ts doesn't spawn. Run via the sibling
// verify-from-corpus.config.ts locally. Skip in CI to keep the standard
// suite green; CI's preview-on-4173 doesn't satisfy this baseURL.
test.skip(
  !!process.env.CI,
  "ad-hoc verifier — requires vite dev on 5173 (use the sibling config locally)",
);

test("from-corpus authoring boxes are editable after anchoring a passage", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  await page.goto("/authoring");

  // Some screens have a tab/mode toggle for "From the corpus". Try to click
  // one if present — otherwise the route lands here directly.
  const modeToggle = page.getByRole("button", { name: /from the corpus/i });
  if ((await modeToggle.count()) > 0) {
    await modeToggle.first().click().catch(() => {});
  }

  await expect(page.getByText(/Corpus files/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // Click the first file in the left rail.
  const fileButton = page.getByTestId("from-corpus-file").first();
  await expect(fileButton).toBeVisible({ timeout: 15_000 });
  await fileButton.click();

  // Wait for passages to load.
  const passageList = page.getByTestId("from-corpus-passage-list");
  await expect(passageList).toBeVisible({ timeout: 20_000 });

  // Before anchoring: the empty-state should be visible.
  const emptyState = page.getByTestId("empty-state-no-anchor");
  const emptyStateBefore = await emptyState.isVisible().catch(() => false);
  console.log(`[verifier] empty-state visible before click: ${emptyStateBefore}`);

  // Click the first passage.
  const firstPassage = page.getByTestId("from-corpus-passage").first();
  await expect(firstPassage).toBeVisible({ timeout: 10_000 });
  await firstPassage.click();

  // After click: empty-state should be gone, anchored-passage banner visible.
  const emptyStateGone = await emptyState
    .waitFor({ state: "hidden", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`[verifier] empty-state hidden after click: ${emptyStateGone}`);

  const anchoredBanner = page.getByTestId("anchored-passage");
  const anchoredVisible = await anchoredBanner
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`[verifier] anchored-passage visible: ${anchoredVisible}`);

  // Capture surrounding DOM for debugging.
  const mainHtml = await page
    .locator("main, [role='main'], body")
    .first()
    .innerHTML()
    .catch(() => "");
  console.log(
    `[verifier] DOM snippet around textareas:\n${mainHtml.slice(0, 4000)}`,
  );

  // Locate the Question textarea by its label (Field wraps a label+textarea).
  const questionTextarea = page.getByLabel(/^Question/i);
  const questionExists = (await questionTextarea.count()) > 0;
  console.log(`[verifier] Question textarea exists: ${questionExists}`);

  let questionEditable = false;
  if (questionExists) {
    const disabled = await questionTextarea.first().getAttribute("disabled");
    const readonly = await questionTextarea.first().getAttribute("readonly");
    console.log(
      `[verifier] Question textarea disabled=${disabled} readonly=${readonly}`,
    );
    try {
      await questionTextarea
        .first()
        .fill("What does B1 say about Race Director?");
      const val = await questionTextarea.first().inputValue();
      questionEditable = val === "What does B1 say about Race Director?";
      console.log(`[verifier] Question textarea value after fill: "${val}"`);
    } catch (e) {
      console.log(`[verifier] Question fill threw: ${(e as Error).message}`);
    }
  }

  // Locate the Ground-truth textarea by label.
  const answerTextarea = page.getByLabel(/Ground-truth/i);
  const answerExists = (await answerTextarea.count()) > 0;
  console.log(`[verifier] Ground-truth textarea exists: ${answerExists}`);

  let answerEditable = false;
  if (answerExists) {
    const disabled = await answerTextarea.first().getAttribute("disabled");
    const readonly = await answerTextarea.first().getAttribute("readonly");
    console.log(
      `[verifier] Ground-truth textarea disabled=${disabled} readonly=${readonly}`,
    );
    try {
      await answerTextarea.first().fill("Test answer");
      const val = await answerTextarea.first().inputValue();
      answerEditable = val === "Test answer";
      console.log(`[verifier] Ground-truth textarea value after fill: "${val}"`);
    } catch (e) {
      console.log(`[verifier] Answer fill threw: ${(e as Error).message}`);
    }
  }

  console.log(`[verifier] Console errors: ${JSON.stringify(consoleErrors)}`);

  // Always grab a screenshot for the report.
  await page.screenshot({
    path: "test-results/verify-from-corpus.png",
    fullPage: true,
  });

  // Now assert the user-visible expectations.
  expect(emptyStateBefore, "empty-state visible before click").toBe(true);
  expect(emptyStateGone, "empty-state hidden after click").toBe(true);
  expect(anchoredVisible, "anchored-passage banner visible").toBe(true);
  expect(questionExists, "Question textarea present").toBe(true);
  expect(answerExists, "Ground-truth textarea present").toBe(true);
  expect(questionEditable, "Question textarea accepts typing").toBe(true);
  expect(answerEditable, "Ground-truth textarea accepts typing").toBe(true);
});
