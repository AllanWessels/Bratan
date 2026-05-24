import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

import { Settings } from "./Settings";

/**
 * Drives every sidebar nav button (8 sections) on the Settings page and
 * asserts the expected section renders. The per-section input actuation
 * is covered in each Step*.actuation.test.tsx file; this file is the
 * end-to-end "navigation actually works for every section" sweep.
 */

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
  project: { project_name: "x", corpus_path: "./c", seed_target_n: 50 },
  vector_db: { adapter: "chroma", chroma_path: "./.chroma", chroma_collection: "c" },
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

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
}));

vi.mock("@/api/hooks", async () => {
  const real = await vi.importActual<typeof import("@/api/hooks")>("@/api/hooks");
  return { ...real, useConfig: mocks.useConfig };
});

beforeEach(() => {
  captured = [];
  mockFetch();
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Settings actuation — navigate to every section", () => {
  it("clicking Project lands on the Project Basics panel", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    // Project is default; click Vector DB first then back to Project to
    // exercise the click handler explicitly.
    await user.click(screen.getByRole("button", { name: /Vector DB/i }));
    await user.click(screen.getByRole("button", { name: /^Project$/i }));
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
  });

  it("clicking Vector DB lands on the adapter picker", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Vector DB/i }));
    expect(screen.getByRole("button", { name: /ChromaDB/ })).toBeInTheDocument();
  });

  it("clicking Models lands on the Anthropic/vLLM panels", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /^Models$/i }));
    expect(screen.getByLabelText(/^api key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  });

  it("clicking Cost ceilings lands on the four cost inputs", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Cost ceilings/i }));
    expect(screen.getByLabelText(/usd per run/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tokens per iteration/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cache ttl/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/subset eval size/i)).toBeInTheDocument();
  });

  it("clicking Seed target lands on the seed slider", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Seed target/i }));
    expect(
      screen.getByLabelText(/target number of seed cases/i),
    ).toBeInTheDocument();
  });

  it("clicking GPU lands on the probe panel", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /^GPU$/i }));
    expect(
      screen.getByRole("button", { name: /detect gpu now|re-detect/i }),
    ).toBeInTheDocument();
  });

  it("clicking Stopping criteria lands on the five stop fields", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Stopping criteria/i }));
    expect(screen.getByLabelText(/convergence threshold/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/convergence window/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max iterations/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/anchor regression threshold/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /warn \(continue\)/i }),
    ).toBeInTheDocument();
  });

  it("clicking Judge weights lands on the three sliders", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Judge weights/i }));
    expect(screen.getByLabelText(/^correctness$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recall @ 5/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^faithfulness$/i)).toBeInTheDocument();
  });
});
