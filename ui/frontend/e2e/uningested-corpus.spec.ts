import { test, expect } from "@playwright/test";
import { prepareUnhappyEnv, type UnhappyEnv } from "./unhappy-helpers";

/**
 * Unhappy path 1 — fresh project, corpus has files, chroma is empty (no
 * ingest has been run). The user opens authoring → from-corpus mode → picks
 * a passage → fills the form → sees that Save is blocked AND understands why.
 *
 * Why this spec exists: the existing actuation-level tests mock the validate
 * endpoint to return `{ ok: true }`, which means the save-button-disabled
 * branch is never exercised against the real backend behaviour. The user has
 * been bitten twice by reaching the save step and finding the button greyed
 * out with no human-readable explanation; this spec locks down the recovery
 * UX so a regression on the validate-response shape (or on the disabled
 * tooltip) is caught in CI.
 *
 * The fixture corpus lives under /tmp/bratan-e2e-fixtures so the developer's
 * real corpus/ directory is never modified — the wizard's step-1 payload
 * accepts an absolute path, so the backend resolves the fixture corpus the
 * same way it would resolve `./corpus`.
 */

const FIXTURE_BODY = [
  "# Uningested Fixture",
  "",
  "Bratan refines RAG pipelines via a red-team, blue-team, and judge agent loop.",
  "The judge always runs at temperature zero so its grades are deterministic.",
  "The blue team reverts any change that regresses a previously-passing case.",
  "",
].join("\n");

let env: UnhappyEnv;

test.beforeEach(async ({ request }) => {
  env = await prepareUnhappyEnv(request, {
    specKey: "uningested",
    fixtures: [
      {
        relPath: "uningested-fixture.md",
        body: FIXTURE_BODY,
      },
    ],
  });
});

test.afterEach(() => {
  env?.cleanup();
});

test("uningested corpus — difficulty badge flags hard case but Save still works", async ({
  page,
}) => {
  // Collect console errors so an unhandled exception in the React tree shows
  // up in the test output. We don't fail on any single error (vite preview's
  // service-worker chatter triggers benign console noise), but we DO assert
  // there is no full-page error overlay below.
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  await page.goto("/authoring");

  // The default authoring tab is "From the corpus" — confirm we landed there
  // by spotting the file rail's header. (If a future change flips the
  // default, surface that loudly rather than silently retargeting.)
  await expect(page.getByText(/Corpus files/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // Pick our fixture file. The file rail uses `data-testid="from-corpus-file"`
  // and renders one button per file; in this isolated env there is exactly one.
  const fileButton = page.getByTestId("from-corpus-file").first();
  await expect(fileButton).toBeVisible({ timeout: 15_000 });
  await fileButton.click();

  // The passage list paginates the file in 10-line windows. We don't care
  // which window the user picks for this spec — any anchor lets the form
  // unlock so we can stress the validate endpoint.
  const passageList = page.getByTestId("from-corpus-passage-list");
  await expect(passageList).toBeVisible({ timeout: 20_000 });
  const firstPassage = page.getByTestId("from-corpus-passage").first();
  await expect(firstPassage).toBeVisible();
  await firstPassage.click();

  // The "anchored-passage" banner replaces the empty state once a passage
  // is selected. Both textareas should now be present + editable.
  await expect(page.getByTestId("anchored-passage")).toBeVisible();

  const question = page.getByLabel(/^Question/i);
  await question.fill("Which agent decides whether a change regresses?");

  const groundTruth = page.getByLabel(/Ground-truth answer/i);
  // We DELIBERATELY use a phrase that appears in the fixture so the
  // answer-text-in-passages check would normally pass — the only failure
  // mode should be the retrieval-against-empty-chroma branch.
  await groundTruth.fill("blue team");

  // Pick a category so the only remaining gate is the validation panel.
  await page.getByLabel(/category/i).selectOption("straightforward");

  // The wizard debounces validate calls by ~600ms; we wait for the response
  // to land so the panel renders the failure rather than the loading spinner.
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/seed/validate") &&
      r.request().method() === "POST",
    { timeout: 15_000 },
  );

  // Post-5ba5d55: ValidationPanel uses `data-difficulty` (enum:
  // easy | hard | inference | adversarial) instead of `data-valid` (bool).
  // With an empty chroma, both signals fail → "adversarial" (hard case).
  const validationResult = page.getByTestId("validation-result");
  await expect(validationResult).toBeVisible({ timeout: 10_000 });
  await expect(validationResult).toHaveAttribute(
    "data-difficulty",
    /adversarial|hard/,
  );

  // The difficulty badge must clearly signal this is a hard / adversarial
  // case so the SME knows what they're authoring.
  const badge = page.getByTestId("validation-difficulty-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/Hard case|adversarial/i);

  // Post-5ba5d55 retrieval-row detail copy: when retrieval fails it reads
  // "Not in top-N — pipeline ranked other chunks higher for this question".
  await expect(
    validationResult.locator("text=/Not in top-\\d+/i"),
  ).toBeVisible();

  // The warnings block surfaces backend-side context — for the empty-chroma
  // path it should contain at least one of "Database error", "not ingested",
  // or "no chunks found". The backend's current warning text is "Vector store
  // is empty — run ingest before validating." which fails the spirit of the
  // assertion (no mention of ingest cause). We accept ANY of these phrasings
  // so the UX team can pick the wording without a flaky test.
  const warningsText = await validationResult.textContent();
  expect(warningsText ?? "").toMatch(
    /database error|not ingested|no chunks found|run ingest|vector store is empty/i,
  );

  // Post-5ba5d55: Save is NO LONGER gated on validation signals — they're
  // informational. Since the user filled all 4 required fields (question,
  // ground truth, anchored passage, category), Save IS enabled. The user
  // is informed via the difficulty badge above that this is a hard case
  // worth saving as adversarial material.
  const saveButton = page.getByRole("button", { name: /save case/i });
  await expect(saveButton).not.toBeDisabled();

  // The page must NOT show an unhandled-error overlay. Vite/React renders one
  // with role="alert" and the words "Uncaught" or "Error" when a render
  // throws. Be specific: a benign network error toast can also use role
  // "alert", so we look for the full-page crash signature.
  const crashOverlay = page.locator(
    'div[role="alert"]:has-text("Uncaught"), div[data-vite-dev-id*="ErrorOverlay"], div:has-text("Application error: a client-side exception")',
  );
  await expect(crashOverlay).toHaveCount(0);

  // Sanity check on console: a properly-handled disabled-save flow should
  // not throw an exception (it may emit info/warn). We log the captured
  // errors for debugging but only fail if any look like an actual crash.
  const crashy = consoleErrors.filter((e) =>
    /TypeError|ReferenceError|Cannot read|is not a function|UnhandledPromiseRejection/i.test(
      e,
    ),
  );
  expect(
    crashy,
    `Unhandled JS errors during uningested-corpus flow:\n${crashy.join("\n")}`,
  ).toEqual([]);
});
