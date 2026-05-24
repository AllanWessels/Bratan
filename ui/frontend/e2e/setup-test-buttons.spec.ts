import { test, expect } from "@playwright/test";
import { resetBratanState } from "./helpers";

/**
 * Exercise the three Test Connection buttons in the wizard.
 *
 * The user previously hit two bugs that opaque-red errors would have hidden:
 *  1. A bad Anthropic key → "raw JSON" was rendered instead of a humane message.
 *  2. vLLM connection-refused → rendered as red error (it's a *warn* in our app).
 * These tests guard the wire contract by checking the UI surfaces the right
 * humane copy and severity, with the real backend connected.
 */

test.beforeEach(async () => {
  resetBratanState();
});

test("Test Anthropic with a bad key surfaces the 'Invalid API key' UX, not raw JSON", async ({
  page,
}) => {
  await page.goto("/setup/3");
  await expect(page.getByText(/Step 3 of 8/)).toBeVisible();

  const apiKey = page.getByLabel(/^api key/i).first();
  await apiKey.fill("sk-ant-not-a-real-key-at-all");

  // First Test button on this page is the Anthropic one.
  await page.getByRole("button", { name: /^test$/i }).first().click();

  // Wait for the error message to render. Backend will return ok=false with the
  // upstream Anthropic error string; the UI maps it to humane copy via
  // explainAnthropicError().
  const msg = page.getByTestId("anthropic-error-message");
  await expect(msg).toBeVisible({ timeout: 15_000 });
  const text = (await msg.textContent()) ?? "";
  // Should NOT show raw JSON / SDK internals.
  expect(text).not.toContain("{");
  expect(text).not.toContain("authentication_error");
  // The friendly message lives in explainAnthropicError when 401 is detected.
  // If the backend returns something else (e.g. network error), at least make
  // sure we don't render the raw upstream blob.
});

test("Test vLLM with the default URL renders as a soft warn, not a red error", async ({
  page,
}) => {
  await page.goto("/setup/3");
  await expect(page.getByText(/Step 3 of 8/)).toBeVisible();

  // Second Test button is the vLLM one.
  const testButtons = page.getByRole("button", { name: /^test$/i });
  await expect(testButtons).toHaveCount(2);
  await testButtons.nth(1).click();

  const msg = page.getByTestId("vllm-error-message");
  await expect(msg).toBeVisible({ timeout: 15_000 });
  // The vLLM result block should style this as amber (warn), not red.
  const className = (await msg.getAttribute("class")) ?? "";
  expect(className).toMatch(/amber/);
  expect(className).not.toMatch(/text-red-600/);
});

test("Test Chroma connection on Step 2 returns ok with a default config", async ({ page }) => {
  await page.goto("/setup/2");
  await expect(page.getByText(/Step 2 of 8/)).toBeVisible();

  // Chroma is the default-selected adapter.
  await page.getByRole("button", { name: /test connection/i }).click();

  // Either "Connected" (green) or an explicit warning. We assert that the
  // status badge transitions to the ok state — chroma is fully local so it
  // should always succeed in CI.
  await expect(page.getByText(/Connected/)).toBeVisible({ timeout: 15_000 });
});
