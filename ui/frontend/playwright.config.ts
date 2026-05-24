import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Playwright config for Bratan's browser-based E2E suite.
 *
 * Why preview (not dev): we exercise the *production* JS bundle that CI ships,
 * not the dev server's hot-reload variant. Configures vite preview on 4173
 * (with /api proxied to 127.0.0.1:8000 — see vite.config.ts) and spins up the
 * FastAPI backend via uv on 8000.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const FRONTEND_URL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // tests share filesystem state (bratan.config.yaml, seed.jsonl)
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "./test-results",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: FRONTEND_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Run the production build via vite preview.
      command:
        "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
      url: FRONTEND_URL,
      cwd: HERE,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // FastAPI backend. The BRATAN_PROJECT_ROOT env var anchors all file I/O
      // (bratan.config.yaml, .bratan-setup.json, test_cases/, reports/, .chroma/)
      // so the e2e suite cannot accidentally clobber the developer's real config.
      command:
        "uv run uvicorn ui.backend.app:app --host 127.0.0.1 --port 8000 --log-level warning",
      url: "http://127.0.0.1:8000/api/health",
      cwd: PROJECT_ROOT,
      env: {
        BRATAN_PROJECT_ROOT: PROJECT_ROOT,
        PYTHONUNBUFFERED: "1",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
