import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, ProbeResult } from "@/api/types";

/**
 * Audit row 13 — Step 6 GPU probe one-shot mark-completed.
 *
 * The step has no fields to save; the wizard's left-nav checkmark is lit by
 * a fire-once `useEffect` that POSTs `{step:6, data:{}}` to
 * `/api/setup/save-step` when `probe.isSuccess` flips true. The effect is
 * guarded by a `markedDone` ref so re-detect (a second successful probe)
 * does NOT re-fire it.
 *
 * Test:
 *   - mount with probe { isLoading:true } → no save call yet.
 *   - rerender with probe { isSuccess:true, data:… } → exactly ONE
 *     `{step:6, data:{}}` save call.
 *   - rerender AGAIN with a fresh successful probe (simulates re-detect)
 *     → save count STAYS at 1.
 *
 * Underpins the sidebar checkmark — silently double-fired before the
 * ref guard landed and could repaint the indicator twice on re-detect.
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
    project: { project_name: "bratan", corpus_path: "./corpus", seed_target_n: 50 },
    vector_db: {
      adapter: "chroma",
      chroma_path: "./.chroma",
      chroma_collection: "corpus",
    },
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

const probeSuccess: ProbeResult = {
  gpu: {
    detected: true,
    name: "NVIDIA RTX 4080",
    vram_total_mb: 16_303,
    vram_free_mb: 14_000,
  },
  vllm_reachable: false,
  vllm_url: "http://localhost:8001",
  anthropic_key_set: true,
};

const probeSuccessAfterRedetect: ProbeResult = {
  ...probeSuccess,
  // Different data shape to simulate a real re-detect returning slightly
  // different free VRAM (e.g. another process freed memory). The mark-done
  // effect must NOT fire again regardless.
  gpu: { ...probeSuccess.gpu, vram_free_mb: 14_500 },
};

describe("Step6GPU — one-shot mark-completed", () => {
  let saveMutate: ReturnType<typeof vi.fn>;
  let probeMutate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saveMutate = vi.fn();
    probeMutate = vi.fn();
    mocks.useSaveStep.mockReturnValue({ mutate: saveMutate });
  });

  it("fires save-step exactly once on first probe success and never on re-detect", () => {
    // ---- Initial mount: probe is in flight, no success yet ----------------
    mocks.useProbe.mockReturnValue({
      data: undefined,
      mutate: probeMutate,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      isError: false,
    });

    const { rerender } = render(withProviders(<Step6GPU config={makeConfig()} />));

    // Mount fired the auto-probe (separate effect) but the success-gated
    // mark-done effect has not — `isSuccess` is false.
    expect(saveMutate.mock.calls).toHaveLength(0);

    // ---- First probe success: mark-done fires exactly once ----------------
    mocks.useProbe.mockReturnValue({
      data: probeSuccess,
      mutate: probeMutate,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    rerender(withProviders(<Step6GPU config={makeConfig()} />));

    expect(saveMutate.mock.calls).toHaveLength(1);
    expect(saveMutate.mock.calls[0][0]).toEqual({ step: 6, data: {} });

    // ---- Re-detect: the mutation cycles isSuccess back to false (pending)
    // and then true again. The `markedDone` ref must keep the save-step
    // effect from firing a SECOND time across this cycle.
    mocks.useProbe.mockReturnValue({
      data: probeSuccess,
      mutate: probeMutate,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      isError: false,
    });
    rerender(withProviders(<Step6GPU config={makeConfig()} />));
    // Sanity: an in-flight re-detect still hasn't moved the save count.
    expect(saveMutate.mock.calls).toHaveLength(1);

    mocks.useProbe.mockReturnValue({
      data: probeSuccessAfterRedetect,
      mutate: probeMutate,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    rerender(withProviders(<Step6GPU config={makeConfig()} />));

    // The ref-guarded effect must NOT re-fire on the second success.
    expect(saveMutate.mock.calls).toHaveLength(1);
  });
});
