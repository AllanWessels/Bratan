---
name: observable-outcome-tests-over-mocks
description: Tests that mock the layer where the bug lives cannot catch bugs at that layer. Write tests that drive the same code path the user drives, ending at something the user can see.
metadata:
  tags: [testing, quality, mocks, observable-behavior]
---

# Observable Outcome Tests Over Mocks

## When to use

- A bug escaped a "passing" test suite — the test mocked the layer the bug lives in.
- You are writing a test for a component that depends on a hook or API call.
- You need to verify cross-component behavior (component A's state should
  refresh component B's display via a shared cache or query client).
- You are auditing an existing test suite for structural blind spots.

## When NOT to use

- The mock is for an external service with no hermetic alternative (network
  call to a third-party API, hardware probe). In that case, mock at the
  network boundary (msw / httpx mock transport), not at the hook level.
- Unit-testing a pure function with no component coupling.
- The test's goal is to verify the *shape* of the payload sent to an API
  (wire-shape coverage) — mocking the API response is appropriate here,
  as long as you also have an observable-outcome test at the integration level.

## How to apply

### The three observable-outcome patterns

#### 1. Cross-query invalidation

**Problem:** Component A mutates data; component B should re-render with the
new data via a shared query cache. Tests that mock `useComponentA` and
`useComponentB` independently cannot catch the coupling.

**Fix:** Render both components in the same test with a real `QueryClient` and
a stubbed HTTP transport:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

const server = setupServer(
  rest.post("/api/ingest", (req, res, ctx) => res(ctx.json({ ok: true }))),
  rest.get("/api/corpus", (req, res, ctx) =>
    res(ctx.json({ files: [{ id: "f1", n_chunks: 42 }] }))
  ),
);

test("ingest → corpus list shows chunk count", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IngestButton fileId="f1" />
      <CorpusList />
    </QueryClientProvider>
  );

  await userEvent.click(screen.getByRole("button", { name: /ingest/i }));

  // Observable outcome: the user sees the chunk count, not the internal state
  await waitFor(() =>
    expect(screen.getByText("42 chunks")).toBeInTheDocument()
  );
});
```

#### 2. Observable persistence

**Problem:** "Ingest succeeds but list_corpus reports false" — the mutation
succeeds, the test asserts the mutation was called, but nothing asserts that
the *list* reflects the change.

**Fix:** Assert the post-action *visible state*, not the call count:

```typescript
// BAD — asserts internal behavior, not user-visible outcome
expect(startIngest.mutate).toHaveBeenCalledTimes(1);

// GOOD — asserts what the user sees after the action completes
await waitFor(() =>
  expect(screen.getByTestId("corpus-row-f1")).toHaveTextContent("42 chunks")
);
```

#### 3. Empty-state / gating assertions

**Problem:** Tests skip directly to the "after action" state. The user-reported
bug is in the "before action" state (misleading labels, broken placeholders,
incorrectly-enabled controls).

**Fix:** Assert BOTH states — empty/locked state before the action AND the
enabled state after:

```typescript
test("writing surface is locked until a passage is anchored", async () => {
  render(<CaseWizard />);

  // EMPTY STATE: user sees this first
  expect(screen.getByTestId("empty-state-no-anchor")).toBeVisible();
  expect(screen.queryByLabelText(/question/i)).not.toBeInTheDocument();

  // ACTION: user anchors a passage
  await userEvent.click(screen.getByTestId("passage-item-1"));

  // ENABLED STATE: now the writing surface appears
  expect(screen.queryByTestId("empty-state-no-anchor")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/question/i)).toBeEnabled();
});
```

### Playwright for cross-component / cross-route flows

Some interactions cannot be tested at the unit level without mocking the very
thing you need to test. Promote these to Playwright:

- Multi-step wizard state that must persist across route navigations.
- Config changes in step N that affect the UI in step M.
- Ingest → corpus browser refresh (mutation → cache invalidation → re-render).
- Authoring → file-on-disk persistence.

Playwright spec template (minimum viable assertions):

```typescript
test("<feature> — full state machine", async ({ page }) => {
  await resetAppState();         // hermetic start
  await page.goto("/<route>");

  // 1. EMPTY state — assert before any action
  await expect(page.getByTestId("<feature>-empty-state")).toBeVisible();

  // 2. ACTION
  await page.getByRole("button", { name: /<cta>/i }).click();

  // 3. LOADING → DONE transition
  await expect(page.getByTestId("<feature>-loading")).toBeVisible();
  await expect(page.getByTestId("<feature>-loading")).toBeHidden();

  // 4. ENABLED state
  await expect(page.getByLabel(/<input>/i)).toBeEnabled();

  // 5. PERSISTENCE — survive a reload
  await page.reload();
  await expect(page.getByLabel(/<input>/i)).toHaveValue("expected");

  // 6. ERROR PATH — force failure, assert humane copy
  // 7. RECOVERY — fix failure, assert error UX clears
});
```

## Why this works

A test that mocks a hook exercises the *test's wiring*, not the *component's
wiring*. The bug you are trying to catch is in the coupling between the component
and the hook — that coupling is exactly what the mock removes. Observable-outcome
tests are harder to write and slower to run, but they test the contract the user
has with the system, not the contract the test author has with the mock.

## Anti-patterns to avoid

- **`vi.hoisted` mocking every hook** — if every dependency is mocked, the test
  proves the component renders correctly when all its dependencies cooperate. That
  is not a useful property.
- **Asserting call counts instead of visible state** — `expect(fn).toHaveBeenCalledTimes(1)`
  tells you the function ran. It does not tell you what the user sees.
- **Tests that only assert the "after" state** — the bug is often in the
  "before" state. Always assert both.
- **Ad-hoc verifier Playwright specs that don't run in CI** — a spec that only
  runs manually against a dev server is not part of the test suite. Fold it into
  CI or delete it.

## Cross-links

- [[audit-then-fanout-fix]] — how to systematically find mock-blind-spot gaps
  before writing the replacement tests
- [[fix-first-then-test]] — observable-outcome failures reveal real bugs;
  fix the code before re-running
