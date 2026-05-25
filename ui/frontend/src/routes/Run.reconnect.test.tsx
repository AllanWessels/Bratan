import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, LoopStatus } from "@/api/types";

/**
 * Real-error path — audit row 7 (UI coverage 2026-05-24).
 *
 * When the loop is reported as `running:true` but the WebSocket stream
 * is `connected:false`, the user has no way to tell whether the loop is
 * still progressing or whether the dashboard has gone silent. The UI
 * should surface a "connection lost" / "reconnecting" hint.
 *
 * TODO: prod fix — add reconnect hint to Run.tsx. Today the inconsistent
 * state renders only as the side-by-side "Running · offline" string in
 * StatusDot, which does not call out the disconnect to the user. This
 * test will FAIL until Run.tsx surfaces an explicit hint (e.g. a banner
 * or text containing /reconnect|connection lost/i) — leaving it red is
 * the point: the gap is real and worth fixing.
 */

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  useLatestReport: vi.fn(),
  useReportHistory: vi.fn(),
  useLoopStatus: vi.fn(),
  useLoopStream: vi.fn(),
  useStartLoop: vi.fn(),
  useStopLoop: vi.fn(),
  useResetVectorStore: vi.fn(),
  useIngestStatus: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Run } from "./Run";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const sampleConfig: BratanConfig = {
  project: { project_name: "test", corpus_path: "./corpus", seed_target_n: 50 },
  vector_db: {
    adapter: "chroma",
    chroma_path: "./.chroma",
    chroma_collection: "corpus",
  },
  models: {
    anthropic_api_key: "",
    oracle_model: "claude-sonnet-4-6",
    vllm_base_url: "http://localhost:8001",
    prejudge_model: "Qwen/Qwen2.5-14B-Instruct-AWQ",
    embedding_model: "BAAI/bge-large-en-v1.5",
    reranker_model: "BAAI/bge-reranker-v2-m3",
    use_local_embedding: true,
    use_local_reranker: true,
    use_local_prejudge: true,
  },
  cost: {
    usd_per_run: 5.0,
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

const runningStatus: LoopStatus = {
  running: true,
  task_id: "abc",
  current_iteration: 3,
  started_at: "2026-05-24T10:00:00+00:00",
  iterations_requested: 50,
  last_report_ts: null,
};

beforeEach(() => {
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useLatestReport.mockReturnValue({ data: null, isLoading: false });
  mocks.useReportHistory.mockReturnValue({ data: [], isLoading: false });
  mocks.useLoopStatus.mockReturnValue({ data: runningStatus, isLoading: false });
  mocks.useLoopStream.mockReturnValue({
    reports: [],
    lastStopReason: null,
    connected: false,
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
  mocks.useResetVectorStore.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useIngestStatus.mockReturnValue({
    data: {
      state: "idle",
      task_id: null,
      files_total: 0,
      files_done: 0,
      chunks_written: 0,
      error: null,
    },
    isLoading: false,
  });
});

describe("Run — reconnect indicator when stream drops mid-loop", () => {
  // EXPECTED FAILURE — Run.tsx has no reconnect/connection-lost indicator.
  // Audit row 7. Related to task #68 (make running state more prominent).
  // When fixed in prod, change `it.fails` → `it`.
  it.fails("surfaces a 'connection lost' / 'reconnecting' hint when running:true but stream connected:false", () => {
    render(withProviders(<Run />));
    // Expected: an explicit hint that the websocket dropped while the loop
    // is still believed to be running. "offline" alone (in StatusDot) is
    // insufficient — it reads as a status badge, not a warning the user
    // should act on.
    expect(screen.getByText(/reconnect|connection lost/i)).toBeInTheDocument();
  });
});
