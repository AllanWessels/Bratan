import { defineConfig, devices } from "@playwright/test";

/**
 * One-off Playwright config that runs verify-from-corpus.spec.ts against the
 * LIVE dev server (http://127.0.0.1:5173) without spinning up its own
 * webServer or running global-setup (which mucks with bratan.config.yaml).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /verify-from-corpus\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "./test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // NO webServer — dev servers are already running.
});
