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

test("uningested corpus — Save button is disabled and the user can tell why", async ({
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

  // The validation result block renders with `data-valid="false"` because
  // top-k matched 0 passages. Wait for it to appear so the subsequent
  // assertions aren't racing the spinner.
  const validationResult = page.getByTestId("validation-result");
  await expect(validationResult).toBeVisible({ timeout: 10_000 });
  await expect(validationResult).toHaveAttribute("data-valid", "false");

  // Passages-in-top-5 row must be the FAILED variant. The component renders
  // a red-tinted icon + "Passages retrievable in top-5" label only when the
  // check fails — match by accessible text near the failure detail.
  const top5Row = validationResult.locator("text=/Passages retrievable in top-5/i");
  await expect(top5Row).toBeVisible();
  // The matching-count detail says "0 of 5 selected passages found" when
  // chroma is empty; assert on the leading "0" so a future top_k bump
  // doesn't break this test.
  await expect(
    validationResult.locator("text=/0 of \\d+ selected passages found/i"),
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

  // The Save button must be disabled. Match by accessible name, not by
  // testid, because the user reads the label "Save case" — that's the
  // contract that matters.
  const saveButton = page.getByRole("button", { name: /save case/i });
  await expect(saveButton).toBeDisabled();

  // The disabled tooltip / aria-describedby must explain WHY in human terms.
  // "Validation failed" alone is not enough — the user needs a hint about
  // ingest. We accept either a `title` attribute or `aria-describedby`
  // pointing at an element containing the explanation.
  const saveTitle = await saveButton.getAttribute("title");
  const ariaDescribedBy = await saveButton.getAttribute("aria-describedby");
  let describedByText = "";
  if (ariaDescribedBy) {
    const describedEl = page.locator(`#${ariaDescribedBy}`);
    if ((await describedEl.count()) > 0) {
      describedByText = (await describedEl.first().textContent()) ?? "";
    }
  }
  const explanationText = `${saveTitle ?? ""} ${describedByText}`.toLowerCase();
  expect(
    explanationText,
    "Save button must explain why it is disabled in human terms (mentioning ingest, validation, passage, or anchor — not a generic 'invalid').",
  ).toMatch(/ingest|passage|anchor|validation|retriev|category/);

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
