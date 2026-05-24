import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone Playwright config for wizard-walk-full.spec.ts that targets the
 * LIVE dev server already running on http://127.0.0.1:5173 (and FastAPI on
 * :8000). No webServer is declared so Playwright won't try to claim :4173
 * (which the default playwright.config.ts uses for `vite preview`).
 *
 * No globalSetup either — the spec resets bratan state itself via a `bash -c`
 * spawn at test start, so it stays self-contained.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /wizard-walk-full\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "./test-results",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // NO webServer block — dev servers are already up.
});
