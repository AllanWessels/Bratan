import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BratanConfig,
  IterationReport,
  LoopStatus,
  ReportSummary,
} from "@/api/types";

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  useLatestReport: vi.fn(),
  useReportHistory: vi.fn(),
  useLoopStatus: vi.fn(),
  useLoopStream: vi.fn(),
  useStartLoop: vi.fn(),
  useStopLoop: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Run } from "./Run";

/**
 * Drives every form control on the Run page's RunControls subview:
 *   - iterations <input type="number">
 *   - budget USD <input type="number">
 *   - skip_red <input type="checkbox">
 *   - no_agents <input type="checkbox">
 *   - Start / Stop buttons
 *
 * Existing Run.test.tsx already covers "all four inputs render" and a
 * happy-path submit. This file adds edge-case actuation:
 *   - editing inputs to extreme values
 *   - toggling each checkbox in isolation
 *   - asserting payload shape per individual change
 *   - asserting Stop calls the right mutation
 */

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  setup_completed_at: null,
};

const sampleStatus: LoopStatus = {
  running: false,
  task_id: null,
  current_iteration: null,
  started_at: null,
  iterations_requested: 0,
  last_report_ts: null,
};

function fakeReport(): IterationReport {
  return {
    timestamp: "2026-05-24T00:00:00Z",
    iteration: 1,
    pipeline_manifest_hash: "h",
    test_set_size: 1,
    composite_mean: 0.5,
    composite_stdev: 0,
    pass_rate_at_0_6: 0,
    per_category: {},
    regressions: [],
    recoveries: [],
    by_case: [],
    cost: {
      oracle_calls: 0,
      prejudge_calls: 0,
      cache_hits: 0,
      usd_spent: 0,
      tokens_in: 0,
      tokens_out: 0,
    },
    latency: {
      p50_total_ms: 0,
      p95_total_ms: 0,
      p50_retrieval_ms: 0,
      p95_retrieval_ms: 0,
      p50_generation_ms: 0,
      p95_generation_ms: 0,
    },
    drift: { samples_checked: 0, disagreement_rate: 0 },
    judge_weights_hash: "h",
    low_confidence_verdicts: [],
    stop_reason: null,
  };
}

function fakeSummary(): ReportSummary {
  return {
    timestamp: "2026-05-24T00:00:00Z",
    iteration: 1,
    composite_mean: 0.5,
    pass_rate_at_0_6: 0,
    stop_reason: null,
  };
}

beforeEach(() => {
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useLatestReport.mockReturnValue({ data: fakeReport(), isLoading: false });
  mocks.useReportHistory.mockReturnValue({ data: [fakeSummary()], isLoading: false });
  mocks.useLoopStatus.mockReturnValue({ data: sampleStatus, isLoading: false });
  mocks.useLoopStream.mockReturnValue({
    reports: [],
    lastStopReason: null,
    connected: true,
  });
  mocks.useStartLoop.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useStopLoop.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
});

describe("Run controls actuation — every input + Start/Stop", () => {
  it("iterations defaults to 1 and accepts integer edits", async () => {
    const user = userEvent.setup();
    render(withProviders(<Run />));
    const it = screen.getByLabelText(/^iterations$/i) as HTMLInputElement;
    expect(it.value).toBe("1");
    await user.clear(it);
    await user.type(it, "10");
    expect(it.value).toBe("10");
  });

  it("budget USD accepts a decimal value", async () => {
    const user = userEvent.setup();
    render(withProviders(<Run />));
    const b = screen.getByLabelText(/budget usd/i) as HTMLInputElement;
    await user.type(b, "3.14");
    expect(b.value).toBe("3.14");
  });

  it("toggling skip_red flips its visible checked state", async () => {
    const user = userEvent.setup();
    render(withProviders(<Run />));
    const cb = screen.getByLabelText(/skip red team/i) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await user.click(cb);
    expect(cb.checked).toBe(true);
    await user.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("toggling no_agents flips its visible checked state", async () => {
    const user = userEvent.setup();
    render(withProviders(<Run />));
    const cb = screen.getByLabelText(/no agents/i) as HTMLInputElement;
    await user.click(cb);
    expect(cb.checked).toBe(true);
  });

  it("Start with empty budget passes budget_usd: null", async () => {
    const startMutate = vi.fn();
    mocks.useStartLoop.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    await user.click(screen.getByTestId("start-button"));
    expect(startMutate).toHaveBeenCalledWith({
      iterations: 1,
      budget_usd: null,
      skip_red: false,
      no_agents: false,
    });
  });

  it("Start with skip_red ON propagates skip_red: true", async () => {
    const startMutate = vi.fn();
    mocks.useStartLoop.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    await user.click(screen.getByLabelText(/skip red team/i));
    await user.click(screen.getByTestId("start-button"));
    expect(startMutate).toHaveBeenCalledWith(
      expect.objectContaining({ skip_red: true }),
    );
  });

  it("Start with no_agents ON propagates no_agents: true", async () => {
    const startMutate = vi.fn();
    mocks.useStartLoop.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    await user.click(screen.getByLabelText(/no agents/i));
    await user.click(screen.getByTestId("start-button"));
    expect(startMutate).toHaveBeenCalledWith(
      expect.objectContaining({ no_agents: true }),
    );
  });

  it("Start with a numeric budget propagates the parsed number", async () => {
    const startMutate = vi.fn();
    mocks.useStartLoop.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    await user.type(screen.getByLabelText(/budget usd/i), "1.5");
    await user.click(screen.getByTestId("start-button"));
    expect(startMutate).toHaveBeenCalledWith(
      expect.objectContaining({ budget_usd: 1.5 }),
    );
  });

  it("Stop button fires the stop mutation while running", async () => {
    const stopMutate = vi.fn();
    mocks.useLoopStatus.mockReturnValue({
      data: { ...sampleStatus, running: true, task_id: "a", started_at: "now" },
      isLoading: false,
    });
    mocks.useStopLoop.mockReturnValue({
      mutate: stopMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    await user.click(screen.getByTestId("stop-button"));
    expect(stopMutate).toHaveBeenCalledTimes(1);
  });

  it("iterations cannot drop below 0 — setting -5 via fireEvent clamps to 0", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(withProviders(<Run />));
    const it = screen.getByLabelText(/^iterations$/i) as HTMLInputElement;
    // userEvent.type fires character-by-character so a "-5" typed run lands
    // as -, then 5 in sequence, which the Math.max(0, ...) clamp resolves
    // to 0 then 5 — losing the clamp signal. fireEvent.change applies the
    // whole value at once, which is what we want to test.
    fireEvent.change(it, { target: { value: "-5" } });
    expect(it.value).toBe("0");
  });
});
