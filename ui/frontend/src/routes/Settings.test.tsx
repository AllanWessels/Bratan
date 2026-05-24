import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

import { Settings } from "./Settings";

// ---------------------------------------------------------------------------
// Test harness
//
// The "wizard wrapping bug" history: a wizard step that sends
// `{step:1, data:{project_name:"x"}}` *looks* like it persists, but Pydantic
// silently drops the unknown keys (extra="ignore"), so the field never lands
// in bratan.config.yaml. The fix is to wrap as `data:{project:{project_name:"x"}}`.
//
// These tests exercise the real Settings -> Step* -> useAutoSaveStep ->
// /api/setup/save-step pipeline with fetch intercepted, then assert each
// section's request body uses the correct top-level key wrapper.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let captured: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function mockFetch() {
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = null;
      }
    }
    captured.push({ url: u, body });
    // The probe endpoint returns the ProbeResult shape; everything else
    // returns the SaveStepResponse shape. Both work as JSON 200.
    if (u.includes("/api/setup/probe")) {
      return new Response(
        JSON.stringify({
          gpu: { detected: false, name: null, vram_total_mb: null, vram_free_mb: null },
          vllm_reachable: false,
          vllm_url: "http://localhost:8001",
          anthropic_key_set: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, config: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const sampleConfig: BratanConfig = {
  project: { project_name: "settings-test", corpus_path: "./corpus", seed_target_n: 50 },
  vector_db: { adapter: "chroma", chroma_path: "./.chroma", chroma_collection: "corpus" },
  models: {
    anthropic_api_key: "",
    oracle_model: "claude-sonnet-4-6",
    vllm_base_url: "http://localhost:8001",
    prejudge_model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
    embedding_model: "BAAI/bge-small-en-v1.5",
    reranker_model: "BAAI/bge-reranker-v2-m3",
    use_local_embedding: true,
    use_local_reranker: true,
    use_local_prejudge: true,
  },
  cost: {
    usd_per_run: 5,
    tokens_per_iteration: 2_000_000,
    cache_ttl_hours: 168,
    subset_eval_size: 10,
  },
  stop: {
    convergence_threshold: 0.02,
    convergence_window: 5,
    max_iterations: 50,
    anchor_regression_threshold: 0.3,
    regression_policy: "warn",
  },
  judge_weights: { correctness: 0.4, recall_at_5: 0.3, faithfulness: 0.3 },
  setup_completed: true,
  setup_completed_at: "2026-05-01T00:00:00Z",
};

// Stub useConfig so the page renders the section in the desired state;
// useSaveStep / useProbe / useTest* run against the captured fetch above.
const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
}));

vi.mock("@/api/hooks", async () => {
  const real = await vi.importActual<typeof import("@/api/hooks")>("@/api/hooks");
  return { ...real, useConfig: mocks.useConfig };
});

async function flushAutoSave() {
  // useAutoSaveStep debounces at 500ms; pad a bit.
  await new Promise((r) => setTimeout(r, 700));
}

function lastSaveStepCall() {
  const calls = captured.filter((c) => c.url.includes("/api/setup/save-step"));
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)!;
}

beforeEach(() => {
  captured = [];
  mockFetch();
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Original Settings smoke tests
// ---------------------------------------------------------------------------

describe("Settings", () => {
  it("renders the sidebar with all 8 sections", () => {
    render(withProviders(<Settings />));
    for (const label of [
      /Project/i,
      /Vector DB/i,
      /Models/i,
      /Cost ceilings/i,
      /Seed target/i,
      /^GPU$/i,
      /Stopping criteria/i,
      /Judge weights/i,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("renders Step1ProjectBasics (the Project section) by default", () => {
    render(withProviders(<Settings />));
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/corpus path/i)).toBeInTheDocument();
  });

  it("populates inputs from config", () => {
    render(withProviders(<Settings />));
    expect(screen.getByLabelText(/project name/i)).toHaveValue("settings-test");
  });

  it("switches the active section when a nav button is clicked", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Cost ceilings/i }));
    expect(screen.getByLabelText(/usd per run/i)).toBeInTheDocument();
  });

  it("links back to /authoring", () => {
    render(withProviders(<Settings />));
    const back = screen.getByRole("link", { name: /back/i });
    expect(back).toHaveAttribute("href", "/authoring");
  });
});

// ---------------------------------------------------------------------------
// PATCH/save-step wrapping parity audit — 6 field groups, one assertion each.
// Each test confirms the request body is shaped {step:N, data:{<top_level_key>:{...}}}
// — *not* the un-wrapped {step:N, data:{<field>:value}} shape Pydantic silently drops.
// ---------------------------------------------------------------------------

describe("Settings wrapping parity audit", () => {
  it("project section wraps as {project: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    // Project is the default section.
    const name = screen.getByLabelText(/project name/i);
    await user.clear(name);
    await user.type(name, "x");
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 1);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["project"]);
    expect((data.project as { project_name: string }).project_name).toBe("x");
  });

  it("vector_db section wraps as {vector_db: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Vector DB/i }));
    const collection = screen.getByLabelText(/collection name/i);
    await user.clear(collection);
    await user.type(collection, "audited");
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 2);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["vector_db"]);
    expect((data.vector_db as { chroma_collection: string }).chroma_collection).toBe(
      "audited",
    );
  });

  it("models section wraps as {models: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Models/i }));
    const oracle = screen.getByLabelText(/oracle model/i);
    await user.clear(oracle);
    await user.type(oracle, "claude-opus");
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 3);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["models"]);
    expect((data.models as { oracle_model: string }).oracle_model).toBe("claude-opus");
  });

  it("cost section wraps as {cost: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Cost ceilings/i }));
    const usd = screen.getByLabelText(/usd per run/i);
    await user.clear(usd);
    await user.type(usd, "12");
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 4);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["cost"]);
    expect((data.cost as { usd_per_run: number }).usd_per_run).toBe(12);
  });

  it("seed-target field still wraps as {project: {...}} (lives in ProjectBasics)", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Seed target/i }));
    const slider = screen.getByLabelText(/target number of seed cases/i);
    // Range inputs fire React's onChange via the change event; userEvent doesn't
    // handle range sliders cleanly, so use fireEvent like Step5SeedTarget.test.tsx.
    fireEvent.change(slider, { target: { value: "100" } });
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 5);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["project"]);
    expect((data.project as { seed_target_n: number }).seed_target_n).toBe(100);
  });

  it("stop section wraps as {stop: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Stopping criteria/i }));
    const maxIter = screen.getByLabelText(/max iterations/i);
    // fireEvent.change avoids the type=number "min=1 -> Number('')||1 = 1"
    // re-render race that makes user.clear+type append onto a stale "1".
    fireEvent.change(maxIter, { target: { value: "77" } });
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 7);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["stop"]);
    expect((data.stop as { max_iterations: number }).max_iterations).toBe(77);
  });

  it("judge_weights section wraps as {judge_weights: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Judge weights/i }));
    const correctness = screen.getByLabelText(/correctness/i);
    fireEvent.change(correctness, { target: { value: "0.5" } });
    await flushAutoSave();
    const call = lastSaveStepCall();
    expect(call.body).toHaveProperty("step", 8);
    const data = (call.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(["judge_weights"]);
    expect(
      (data.judge_weights as { correctness: number }).correctness,
    ).toBeCloseTo(0.5, 2);
  });
});
