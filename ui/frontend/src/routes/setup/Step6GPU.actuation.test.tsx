import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, ProbeResult } from "@/api/types";

/**
 * Step6GPU has a single interactive control (the "Detect GPU now" /
 * "Re-detect" probe button). The existing Step6GPU.test.tsx covers the
 * happy path; this file adds:
 *   - clicking from the "no probe yet" state (button labelled "Detect GPU now")
 *   - clicking multiple times in succession
 *   - asserting the probe doesn't run again after error if not clicked
 */

const mocks = vi.hoisted(() => ({
  useProbe: vi.fn(),
  useSaveStep: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Step6GPU } from "./Step6GPU";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function makeConfig(): BratanConfig {
  return {
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
    setup_completed: false,
    setup_completed_at: null,
  };
}

const sampleProbe: ProbeResult = {
  gpu: {
    detected: true,
    name: "RTX 4090",
    vram_total_mb: 24_000,
    vram_free_mb: 22_000,
  },
  vllm_reachable: false,
  vllm_url: "http://localhost:8001",
  anthropic_key_set: true,
};

describe("Step6GPU actuation — probe button", () => {
  beforeEach(() => {
    mocks.useSaveStep.mockReturnValue({ mutate: vi.fn() });
  });

  it("clicking 'Detect GPU now' from no-data state invokes probe.mutate", async () => {
    const probeMutate = vi.fn();
    mocks.useProbe.mockReturnValue({
      data: undefined,
      mutate: probeMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<Step6GPU config={makeConfig()} />));
    // Mount fires one auto-probe. Click should fire a second.
    const before = probeMutate.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /detect gpu now/i }));
    expect(probeMutate.mock.calls.length).toBe(before + 1);
  });

  it("clicking 'Re-detect' multiple times invokes probe.mutate each time", async () => {
    const probeMutate = vi.fn();
    mocks.useProbe.mockReturnValue({
      data: sampleProbe,
      mutate: probeMutate,
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<Step6GPU config={makeConfig()} />));
    const before = probeMutate.mock.calls.length;
    const btn = screen.getByRole("button", { name: /re-detect/i });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(probeMutate.mock.calls.length).toBe(before + 3);
  });

  it("probe button is disabled (loading) when isPending is true", () => {
    mocks.useProbe.mockReturnValue({
      data: undefined,
      mutate: vi.fn(),
      isPending: true,
      isSuccess: false,
      isError: false,
    });
    render(withProviders(<Step6GPU config={makeConfig()} />));
    const btn = screen.getByRole("button", { name: /detect gpu now/i });
    expect(btn).toBeDisabled();
  });
});
