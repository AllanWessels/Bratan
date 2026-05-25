import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    // multi_hop (0.40) should appear before straightforward (0.90).
    // Labels now use the SME-friendly strings from FAILURE_CATEGORY_LABELS.
    const html = document.body.innerHTML;
    const multiIdx = html.indexOf("Needs multiple passages");
    const straightIdx = html.indexOf("Direct question");
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

  it("renders the cost meter with usd_spent + the budget cap", () => {
    render(withProviders(<Run />));
    // usd_spent is 1.25 (may appear in both cost meter and cost-bars sum),
    // budget is 5.00.
    expect(screen.getAllByText(/\$1\.25/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });

  it("renders the four run-control inputs (iterations / budget / skip_red / no_agents)", () => {
    render(withProviders(<Run />));
    expect(screen.getByLabelText(/^iterations$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/budget usd/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/skip red team/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/no agents/i)).toBeInTheDocument();
  });

  it("submits run controls with the typed values", async () => {
    const startMutate = vi.fn();
    mocks.useStartLoop.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<Run />));
    const iterations = screen.getByLabelText(/^iterations$/i);
    await user.clear(iterations);
    await user.type(iterations, "3");
    const budget = screen.getByLabelText(/budget usd/i);
    await user.type(budget, "2.5");
    await user.click(screen.getByLabelText(/skip red team/i));
    await user.click(screen.getByLabelText(/no agents/i));
    await user.click(screen.getByTestId("start-button"));
    expect(startMutate).toHaveBeenCalledWith({
      iterations: 3,
      budget_usd: 2.5,
      skip_red: true,
      no_agents: true,
    });
  });

  it("clicking Stop fires the stop mutation", async () => {
    const stopMutate = vi.fn();
    mocks.useLoopStatus.mockReturnValue({
      data: { ...sampleStatus, running: true, task_id: "abc", started_at: "now" },
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

  it("disables the run inputs while a run is in progress", () => {
    mocks.useLoopStatus.mockReturnValue({
      data: { ...sampleStatus, running: true, task_id: "abc", started_at: "now" },
      isLoading: false,
    });
    render(withProviders(<Run />));
    expect(screen.getByLabelText(/^iterations$/i)).toBeDisabled();
    expect(screen.getByLabelText(/budget usd/i)).toBeDisabled();
    expect(screen.getByLabelText(/skip red team/i)).toBeDisabled();
    expect(screen.getByLabelText(/no agents/i)).toBeDisabled();
  });

  it("includes streamed reports in the chart series", () => {
    const streamed = fakeReport(4, "2026-05-23T13:00:00+00:00", 0.81);
    mocks.useLoopStream.mockReturnValue({
      reports: [streamed],
      lastStopReason: null,
      connected: true,
    });
    render(withProviders(<Run />));
    const chart = screen.getByTestId("composite-chart");
    expect(chart).toHaveAttribute("data-points", "4");
    expect(screen.getAllByTestId("chart-point")).toHaveLength(4);
  });

  it("renders 'No iterations yet' when no reports are available", () => {
    mocks.useLatestReport.mockReturnValue({ data: null, isLoading: false });
    mocks.useReportHistory.mockReturnValue({ data: [], isLoading: false });
    mocks.useLoopStream.mockReturnValue({
      reports: [],
      lastStopReason: null,
      connected: false,
    });
    render(withProviders(<Run />));
    expect(screen.getByText(/No iterations yet/i)).toBeInTheDocument();
  });

  it("renders 'live' when the stream is connected", () => {
    render(withProviders(<Run />));
    expect(screen.getByText(/^live$/i)).toBeInTheDocument();
  });

  it("renders 'offline' when the stream is disconnected", () => {
    mocks.useLoopStream.mockReturnValue({
      reports: [],
      lastStopReason: null,
      connected: false,
    });
    render(withProviders(<Run />));
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it("renders an over-budget cost meter in red when overrun", () => {
    const over = fakeReport(3, "2026-05-23T12:00:00+00:00", 0.72);
    over.cost.usd_spent = 7.5; // > 5 budget
    mocks.useLatestReport.mockReturnValue({ data: over, isLoading: false });
    render(withProviders(<Run />));
    const bar = screen.getAllByRole("progressbar").pop()!;
    const inner = bar.querySelector("div") as HTMLElement;
    expect(inner.className).toMatch(/bg-red-500/);
  });

  it("shows the iteration delta vs the prior iteration", () => {
    render(withProviders(<Run />));
    // Iteration 3 composite was 0.72, prior was 0.68 → +0.04
    expect(screen.getByText(/\+0\.040 vs prior/)).toBeInTheDocument();
  });

  it("does not render the start error message when there is none", () => {
    render(withProviders(<Run />));
    // No mutation error -> no red message
    expect(screen.queryByText(/started loop fail/i)).not.toBeInTheDocument();
  });

  it("renders the start error message when start.isError is true", () => {
    mocks.useStartLoop.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isError: true,
      error: new Error("Couldn't start: invalid budget"),
    });
    render(withProviders(<Run />));
    expect(screen.getByText(/Couldn't start: invalid budget/)).toBeInTheDocument();
  });

  it("renders empty-state for per-category when current is null", () => {
    mocks.useLatestReport.mockReturnValue({ data: null, isLoading: false });
    mocks.useReportHistory.mockReturnValue({ data: [], isLoading: false });
    mocks.useLoopStream.mockReturnValue({
      reports: [],
      lastStopReason: null,
      connected: true,
    });
    render(withProviders(<Run />));
    expect(screen.getByText(/No per-category data yet/i)).toBeInTheDocument();
  });

  it("renders the no-regressions empty state when regressions is empty", () => {
    const clean = fakeReport(3, "2026-05-23T12:00:00+00:00", 0.72);
    clean.regressions = [];
    mocks.useLatestReport.mockReturnValue({ data: clean, isLoading: false });
    render(withProviders(<Run />));
    expect(screen.getByText(/No regressions detected/i)).toBeInTheDocument();
  });

  it("renders the regression case id inside the regressions table", () => {
    render(withProviders(<Run />));
    // The case-001 row is rendered inside a <td> in the regressions table.
    const rows = screen.getAllByText("case-001");
    expect(rows.length).toBeGreaterThan(0);
    expect(within(rows[0].parentElement as HTMLElement).getByText("0.85")).toBeInTheDocument();
  });

  it("renders the per-category trend block with one mini-chart per category", () => {
    // Stream a second full report so multiple iterations are available for trend.
    const r2 = fakeReport(4, "2026-05-23T13:00:00+00:00", 0.78);
    mocks.useLoopStream.mockReturnValue({
      reports: [r2],
      lastStopReason: null,
      connected: true,
    });
    render(withProviders(<Run />));
    expect(screen.getByTestId("per-category-trend")).toBeInTheDocument();
    // Both categories from fakeReport (multi_hop, straightforward) should appear.
    expect(screen.getByTestId("category-mini-multi_hop")).toBeInTheDocument();
    expect(screen.getByTestId("category-mini-straightforward")).toBeInTheDocument();
  });

  it("renders the cost-over-iterations block with one bar per iteration", () => {
    const r2 = fakeReport(4, "2026-05-23T13:00:00+00:00", 0.78);
    r2.cost.usd_spent = 2.0;
    mocks.useLoopStream.mockReturnValue({
      reports: [r2],
      lastStopReason: null,
      connected: true,
    });
    render(withProviders(<Run />));
    const svg = screen.getByTestId("cost-bars-svg");
    expect(svg).toBeInTheDocument();
    // Two iterations of full-report data (latest + streamed) -> 2 bars.
    expect(svg).toHaveAttribute("data-iterations", "2");
    expect(screen.getAllByTestId("cost-bar")).toHaveLength(2);
    // Sum: latest (1.25) + r2 (2.0) = 3.25
    expect(screen.getByText(/\$3\.25/)).toBeInTheDocument();
  });

  it("renders the drift timeline and highlights red when any value > 5%", () => {
    const drifty = fakeReport(4, "2026-05-23T13:00:00+00:00", 0.78);
    drifty.drift.disagreement_rate = 0.07; // > 5%
    drifty.drift.samples_checked = 20;
    mocks.useLoopStream.mockReturnValue({
      reports: [drifty],
      lastStopReason: null,
      connected: true,
    });
    render(withProviders(<Run />));
    const svg = screen.getByTestId("drift-svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("data-warn", "true");
    const latest = screen.getByTestId("drift-latest");
    expect(latest.className).toMatch(/text-red-600/);
  });

  it("composite-chart point clicks navigate to the report-detail route", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/run"]}>
          <Routes>
            <Route path="/run" element={<Run />} />
            <Route
              path="/run/reports/:timestamp"
              element={<div data-testid="detail-landed">landed</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const hits = screen.getAllByTestId("chart-point-hit");
    expect(hits.length).toBe(3);
    await user.click(hits[hits.length - 1]);
    expect(screen.getByTestId("detail-landed")).toBeInTheDocument();
  });
});
