import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

import { Step5SeedTarget } from "./Step5SeedTarget";

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
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function makeConfig(seed: number): BratanConfig {
  return {
    project: { project_name: "bratan", corpus_path: "./corpus", seed_target_n: seed },
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
    setup_completed: false,
    setup_completed_at: null,
  };
}

beforeEach(() => {
  captured = [];
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function flushAutoSave() {
  await new Promise((r) => setTimeout(r, 700));
}

describe("Step5SeedTarget", () => {
  it("renders the number input with default value 50", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    expect(input).toHaveValue(50);
  });

  it("populates from config.project.seed_target_n", () => {
    render(withProviders(<Step5SeedTarget config={makeConfig(125)} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    expect(input).toHaveValue(125);
  });

  it("input has the numeric bounds 10..200 with step 1", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("min", "10");
    expect(input).toHaveAttribute("max", "200");
    expect(input).toHaveAttribute("step", "1");
  });

  it("auto-saves edits wrapped as {project: {seed_target_n: ...}}", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    fireEvent.change(input, { target: { value: "75" } });
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    expect(last.body).toHaveProperty("step", 5);
    const data = (last.body as { data: { project: { seed_target_n: number } } }).data;
    expect(data).toHaveProperty("project");
    expect(data.project.seed_target_n).toBe(75);
  });

  it("renders the 'cases' unit suffix", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    expect(
      screen.getByTestId("number-input-target-number-of-seed-cases-unit"),
    ).toHaveTextContent("cases");
  });
});
