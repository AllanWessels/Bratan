import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

import { Step1ProjectBasics } from "./Step1ProjectBasics";

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
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function sampleConfig(): BratanConfig {
  return {
    project: {
      project_name: "from-config",
      corpus_path: "/tmp/corpus",
      seed_target_n: 42,
    },
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

describe("Step1ProjectBasics", () => {
  it("renders the project name and corpus path inputs", () => {
    render(withProviders(<Step1ProjectBasics config={null} />));
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/corpus path/i)).toBeInTheDocument();
  });

  it("falls back to defaults when no config is provided", () => {
    render(withProviders(<Step1ProjectBasics config={null} />));
    expect(screen.getByLabelText(/project name/i)).toHaveValue("bratan");
    expect(screen.getByLabelText(/corpus path/i)).toHaveValue("./corpus");
  });

  it("populates inputs from the config prop", () => {
    render(withProviders(<Step1ProjectBasics config={sampleConfig()} />));
    expect(screen.getByLabelText(/project name/i)).toHaveValue("from-config");
    expect(screen.getByLabelText(/corpus path/i)).toHaveValue("/tmp/corpus");
  });

  it("auto-saves edits to project_name wrapped as {project: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step1ProjectBasics config={null} />));
    const name = screen.getByLabelText(/project name/i);
    await user.clear(name);
    await user.type(name, "new-project");
    await flushAutoSave();
    const saveCalls = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saveCalls.length).toBeGreaterThan(0);
    const last = saveCalls.at(-1)!;
    expect(last.body).toHaveProperty("step", 1);
    const data = (last.body as { data: { project: { project_name: string } } }).data;
    expect(data).toHaveProperty("project");
    expect(data.project.project_name).toBe("new-project");
  });

  it("auto-saves edits to corpus_path wrapped as {project: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step1ProjectBasics config={null} />));
    const path = screen.getByLabelText(/corpus path/i);
    await user.clear(path);
    await user.type(path, "./docs");
    await flushAutoSave();
    const saveCalls = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saveCalls.length).toBeGreaterThan(0);
    const last = saveCalls.at(-1)!;
    const data = (last.body as { data: { project: { corpus_path: string } } }).data;
    expect(data.project.corpus_path).toBe("./docs");
  });

  it("marks project name as required (visible asterisk)", () => {
    render(withProviders(<Step1ProjectBasics config={null} />));
    // The label has the required asterisk; we assert at least one required field.
    const labels = screen.getAllByText("*");
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });
});
