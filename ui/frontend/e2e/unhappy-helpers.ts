import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetBratanState } from "./helpers";

/**
 * Helpers for the "unhappy path" Playwright specs.
 *
 * These specs are not allowed to touch `/home/allan/projects/bratan/corpus/`
 * (the developer's real working corpus). They instead drop tiny markdown
 * fixtures into a per-test scratch directory under `/tmp/bratan-e2e-fixtures/`
 * and point `bratan.config.yaml`'s `project.corpus_path` at that absolute
 * path. The setup wizard's step-1 payload accepts an absolute path verbatim,
 * so the backend resolves the fixture corpus the same way it would resolve
 * the real `./corpus`.
 *
 * Each spec calls `prepareUnhappyEnv()` once per test in `beforeEach`. The
 * function:
 *   1. Wipes all of bratan's persistent state (config, chroma, seed.jsonl).
 *   2. Creates a fresh `/tmp/bratan-e2e-fixtures/<spec-key>-<random>/corpus/`
 *      directory and writes the requested fixture files into it.
 *   3. Completes the 8-step setup wizard via the backend API so the front
 *      end lands on `/authoring` with a valid config.
 *   4. Returns the absolute corpus dir + per-spec teardown cleanup callback.
 *
 * The chroma path is *also* moved under the scratch dir so a previous test's
 * `.chroma/` can't leak chunks into the current test's vector store.
 */

const BACKEND_URL = "http://127.0.0.1:8000";
const SCRATCH_ROOT = path.join(os.tmpdir(), "bratan-e2e-fixtures");

export interface UnhappyEnv {
  /** Absolute path to the per-test corpus directory. */
  corpusDir: string;
  /** Absolute path to the per-test chroma directory. */
  chromaDir: string;
  /** Absolute path to the spec's scratch root (parent of corpus + chroma). */
  scratchDir: string;
  /** Map of relative path -> absolute path for each fixture written. */
  fixtures: Record<string, string>;
  /** Tear down the scratch directory + reset bratan state. */
  cleanup: () => void;
}

export interface UnhappyFixture {
  /** Path relative to the corpus directory, e.g. `notes.md`. */
  relPath: string;
  /** Markdown body to write to the file. */
  body: string;
}

export interface UnhappyOptions {
  /** Key used to prefix the scratch dir; helps when grepping /tmp. */
  specKey: string;
  /** Fixture files to drop into the corpus dir. May be empty. */
  fixtures: UnhappyFixture[];
}

/**
 * Best-effort POST to the backend's setup endpoints. Throws if any step
 * fails; the spec's beforeEach blows up loud and early rather than landing
 * on a half-configured /authoring page.
 */
async function completeWizardViaApi(
  request: import("@playwright/test").APIRequestContext,
  corpusDir: string,
  chromaDir: string,
): Promise<void> {
  const stepPayloads: Array<[number, Record<string, unknown>]> = [
    [
      1,
      {
        project: {
          project_name: "e2e-unhappy",
          corpus_path: corpusDir,
          seed_target_n: 50,
        },
      },
    ],
    [
      2,
      {
        vector_db: {
          adapter: "chroma",
          chroma_path: chromaDir,
          chroma_collection: "corpus",
        },
      },
    ],
    [
      3,
      {
        models: {
          anthropic_api_key: "sk-ant-e2e-fake",
        },
      },
    ],
  ];
  for (const [step, data] of stepPayloads) {
    const resp = await request.post(`${BACKEND_URL}/api/setup/save-step`, {
      data: { step, data },
    });
    if (!resp.ok()) {
      throw new Error(
        `setup/save-step step=${step} failed: ${resp.status()} ${await resp.text()}`,
      );
    }
  }
  const finish = await request.post(`${BACKEND_URL}/api/setup/finish`);
  if (!finish.ok()) {
    throw new Error(
      `setup/finish failed: ${finish.status()} ${await finish.text()}`,
    );
  }
}

/**
 * Build a scratch corpus dir, complete the wizard, and return handles so the
 * spec can write more files or inspect chroma. Call `env.cleanup()` from
 * `afterEach` to remove the scratch directory and reset bratan state.
 */
export async function prepareUnhappyEnv(
  request: import("@playwright/test").APIRequestContext,
  opts: UnhappyOptions,
): Promise<UnhappyEnv> {
  // Hard-reset bratan's project-root state first: config, chroma, seed.jsonl,
  // drafts. This is the same wipe that global-setup.ts runs once per session;
  // we also do it per-test so each unhappy spec is independent.
  resetBratanState();

  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const random = Math.random().toString(36).slice(2, 8);
  const scratchDir = fs.mkdtempSync(
    path.join(SCRATCH_ROOT, `${opts.specKey}-${random}-`),
  );
  const corpusDir = path.join(scratchDir, "corpus");
  const chromaDir = path.join(scratchDir, ".chroma");
  fs.mkdirSync(corpusDir, { recursive: true });
  // chromaDir is created lazily by the chroma adapter; we just stake out
  // the absolute path here so the wizard records it.

  const fixtures: Record<string, string> = {};
  for (const { relPath, body } of opts.fixtures) {
    const abs = path.join(corpusDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf-8");
    fixtures[relPath] = abs;
  }

  await completeWizardViaApi(request, corpusDir, chromaDir);

  return {
    corpusDir,
    chromaDir,
    scratchDir,
    fixtures,
    cleanup() {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      // resetBratanState clears the bratan.config.yaml + sidecar pointing at
      // the now-deleted scratch dir, so the next test starts clean.
      resetBratanState();
    },
  };
}

/**
 * Trigger a real ingest via the backend API and poll `/api/corpus/ingest/status`
 * until it reaches `succeeded`. The first ingest in a fresh CI environment can
 * be slow (the sentence-transformers model is downloaded the first time the
 * embedder is constructed), so the default timeout is generous.
 *
 * Throws if the ingest ends in `failed` state or the deadline expires.
 */
export async function ingestAndWait(
  request: import("@playwright/test").APIRequestContext,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ chunks_written: number; files_done: number; files_total: number }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const pollMs = opts.pollMs ?? 1000;

  const startResp = await request.post(`${BACKEND_URL}/api/corpus/ingest`);
  if (!startResp.ok()) {
    throw new Error(
      `POST /api/corpus/ingest failed: ${startResp.status()} ${await startResp.text()}`,
    );
  }

  // Poll until terminal state.
  while (Date.now() < deadline) {
    const statusResp = await request.get(`${BACKEND_URL}/api/corpus/ingest/status`);
    if (!statusResp.ok()) {
      throw new Error(
        `GET /api/corpus/ingest/status failed: ${statusResp.status()} ${await statusResp.text()}`,
      );
    }
    const status = (await statusResp.json()) as {
      state: "idle" | "running" | "succeeded" | "failed";
      error?: string | null;
      chunks_written?: number;
      files_done?: number;
      files_total?: number;
    };
    if (status.state === "succeeded") {
      return {
        chunks_written: status.chunks_written ?? 0,
        files_done: status.files_done ?? 0,
        files_total: status.files_total ?? 0,
      };
    }
    if (status.state === "failed") {
      throw new Error(`ingest failed: ${status.error ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`ingest did not finish within ${opts.timeoutMs ?? 180_000}ms`);
}

/**
 * GET /api/seed/list and return the parsed payload. Used to assert that a
 * Save-button click actually wrote the case through to disk — not just to
 * React state.
 */
export async function fetchSeedList(
  request: import("@playwright/test").APIRequestContext,
): Promise<{
  cases: Array<{
    id: string;
    question: string;
    ground_truth: string;
    failure_category: string;
    source_passages: Array<{ path: string; line_start: number; line_end: number }>;
    created_by: string;
    created_at: string;
    notes?: string | null;
  }>;
  target_n: number;
  progress: number;
}> {
  const resp = await request.get(`${BACKEND_URL}/api/seed/list`);
  if (!resp.ok()) {
    throw new Error(
      `GET /api/seed/list failed: ${resp.status()} ${await resp.text()}`,
    );
  }
  return resp.json();
}
