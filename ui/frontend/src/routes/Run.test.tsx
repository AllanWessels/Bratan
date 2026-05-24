import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BratanConfig,
  IterationReport,
  LoopStatus,
  ReportSummary,
} from "@/api/types";

// Mock the api/hooks module so we can drive the component with canned data
// without standing up a real backend.
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
    oracle_model: "claude-sonnet-4-20250514",
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

function fakeReport(iteration: number, ts: string, composite: number): IterationReport {
  return {
    timestamp: ts,
    iteration,
    pipeline_manifest_hash: "h",
    test_set_size: 5,
    composite_mean: composite,
    composite_stdev: 0.05,
    pass_rate_at_0_6: 0.8,
    per_category: {
      multi_hop: { count: 2, avg_composite: 0.4, pass_rate: 0.5 },
      straightforward: { count: 3, avg_composite: 0.9, pass_rate: 1.0 },
    },
    regressions: [
      { case_id: "case-001", previous: 0.85, current: 0.45 },
    ],
    recoveries: [],
    by_case: [],
    cost: {
      oracle_calls: 5,
      prejudge_calls: 0,
      cache_hits: 0,
      usd_spent: 1.25,
      tokens_in: 100,
      tokens_out: 50,
    },
    latency: {
      p50_total_ms: 100,
      p95_total_ms: 220,
      p50_retrieval_ms: 10,
      p95_retrieval_ms: 20,
      p50_generation_ms: 90,
      p95_generation_ms: 200,
    },
    drift: { samples_checked: 0, disagreement_rate: 0.0 },
    judge_weights_hash: "w",
    low_confidence_verdicts: [],
    stop_reason: null,
  };
}

function fakeSummary(report: IterationReport): ReportSummary {
  return {
    timestamp: report.timestamp,
    iteration: report.iteration,
    composite_mean: report.composite_mean,
    pass_rate_at_0_6: report.pass_rate_at_0_6,
    stop_reason: report.stop_reason,
  };
}

const sampleStatus: LoopStatus = {
  running: false,
  task_id: null,
  current_iteration: null,
  started_at: null,
  iterations_requested: 0,
  last_report_ts: null,
};

describe("Run", () => {
  beforeEach(() => {
    const reports = [
      fakeReport(1, "2026-05-23T10:00:00+00:00", 0.55),
      fakeReport(2, "2026-05-23T11:00:00+00:00", 0.68),
      fakeReport(3, "2026-05-23T12:00:00+00:00", 0.72),
    ];
    mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
    mocks.useLatestReport.mockReturnValue({ data: reports[2], isLoading: false });
    mocks.useReportHistory.mockReturnValue({
      data: reports.map(fakeSummary),
      isLoading: false,
    });
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

  it("renders composite mean and pass rate from latest report", () => {
    render(withProviders(<Run />));
    expect(screen.getByText("0.720")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("renders the composite-over-time chart with one point per iteration", () => {
    render(withProviders(<Run />));
    const chart = screen.getByTestId("composite-chart");
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAttribute("data-points", "3");
    expect(screen.getAllByTestId("chart-point")).toHaveLength(3);
  });

  it("renders per-category bars sorted worst first", () => {
    render(withProviders(<Run />));
    // multi_hop (0.40) should appear before straightforward (0.90)
    const html = document.body.innerHTML;
    const multiIdx = html.indexOf("Multi Hop");
    const straightIdx = html.indexOf("Straightforward");
    expect(multiIdx).toBeGreaterThanOrEqual(0);
    expect(straightIdx).toBeGreaterThan(multiIdx);
  });

  it("renders regressions table with previous and current scores", () => {
    render(withProviders(<Run />));
    expect(screen.getByText("case-001")).toBeInTheDocument();
    expect(screen.getByText("0.85")).toBeInTheDocument();
    expect(screen.getByText("0.45")).toBeInTheDocument();
  });

  it("shows the Start button when idle", () => {
    render(withProviders(<Run />));
    expect(screen.getByTestId("start-button")).toBeInTheDocument();
    expect(screen.queryByTestId("stop-button")).not.toBeInTheDocument();
  });

  it("shows the Stop button while running", () => {
    mocks.useLoopStatus.mockReturnValue({
      data: { ...sampleStatus, running: true, task_id: "abc", started_at: "now" },
      isLoading: false,
    });
    render(withProviders(<Run />));
    expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    expect(screen.queryByTestId("start-button")).not.toBeInTheDocument();
  });

  it("renders a stop_reason badge when present", () => {
    const stopped = fakeReport(3, "2026-05-23T12:00:00+00:00", 0.72);
    stopped.stop_reason = "convergence";
    mocks.useLatestReport.mockReturnValue({ data: stopped, isLoading: false });
    render(withProviders(<Run />));
    expect(screen.getByTestId("stop-badge")).toHaveTextContent(/convergence/);
  });
});
