import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IterationReport } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useReportByTimestamp: vi.fn(),
  // Run uses these — Routes will render <Run/> when we navigate back; we
  // need the same mock set the Run.test uses.
  useConfig: vi.fn(),
  useLatestReport: vi.fn(),
  useReportHistory: vi.fn(),
  useLoopStatus: vi.fn(),
  useLoopStream: vi.fn(),
  useStartLoop: vi.fn(),
  useStopLoop: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { RunReportDetail, highlightJson } from "./RunReportDetail";
import { Run } from "./Run";

function fakeReport(): IterationReport {
  return {
    timestamp: "2026-05-23T12:00:00+00:00",
    iteration: 7,
    pipeline_manifest_hash: "abc123",
    test_set_size: 12,
    composite_mean: 0.642,
    composite_stdev: 0.18,
    pass_rate_at_0_6: 0.75,
    per_category: {
      multi_hop: { count: 4, avg_composite: 0.5, pass_rate: 0.5 },
    },
    regressions: [],
    recoveries: [],
    by_case: [],
    cost: {
      oracle_calls: 8,
      prejudge_calls: 4,
      cache_hits: 2,
      usd_spent: 3.42,
      tokens_in: 1234,
      tokens_out: 567,
    },
    latency: {
      p50_total_ms: 120,
      p95_total_ms: 310,
      p50_retrieval_ms: 18,
      p95_retrieval_ms: 42,
      p50_generation_ms: 100,
      p95_generation_ms: 280,
    },
    drift: { samples_checked: 5, disagreement_rate: 0.02 },
    judge_weights_hash: "w-hash",
    low_confidence_verdicts: [],
    stop_reason: null,
  };
}

function withProviders(initial: string, ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.useReportByTimestamp.mockReturnValue({
    data: fakeReport(),
    isLoading: false,
    isError: false,
    error: null,
  });
  // Defaults for the Run route (used by the "back" test).
  mocks.useConfig.mockReturnValue({
    data: {
      project: { project_name: "", corpus_path: "", seed_target_n: 0 },
      vector_db: { adapter: "chroma", chroma_path: "", chroma_collection: "" },
      models: {
        anthropic_api_key: "",
        oracle_model: "",
        vllm_base_url: "",
        prejudge_model: "",
        embedding_model: "",
        reranker_model: "",
        use_local_embedding: true,
        use_local_reranker: true,
        use_local_prejudge: true,
      },
      cost: {
        usd_per_run: 0,
        tokens_per_iteration: 0,
        cache_ttl_hours: 0,
        subset_eval_size: 0,
      },
      stop: {
        convergence_threshold: 0,
        convergence_window: 0,
        max_iterations: 0,
        anchor_regression_threshold: 0,
        regression_policy: "warn",
      },
      judge_weights: { correctness: 0, recall_at_5: 0, faithfulness: 0 },
      setup_completed: true,
      setup_completed_at: null,
    },
    isLoading: false,
  });
  mocks.useLatestReport.mockReturnValue({ data: null, isLoading: false });
  mocks.useReportHistory.mockReturnValue({ data: [], isLoading: false });
  mocks.useLoopStatus.mockReturnValue({
    data: {
      running: false,
      task_id: null,
      current_iteration: null,
      started_at: null,
      iterations_requested: 0,
      last_report_ts: null,
    },
    isLoading: false,
  });
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
});

describe("RunReportDetail", () => {
  it("renders the header and a Back to Run button", () => {
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    expect(screen.getByText(/Report detail/i)).toBeInTheDocument();
    expect(screen.getByTestId("back-to-run")).toBeInTheDocument();
  });

  it("calls the report-by-timestamp hook with the decoded route param", () => {
    render(
      withProviders(
        `/run/reports/${encodeURIComponent("2026-05-23T12:00:00+00:00")}`,
        <Routes>
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    expect(mocks.useReportByTimestamp).toHaveBeenCalled();
    const calledWith = mocks.useReportByTimestamp.mock.calls[0][0];
    expect(calledWith).toBe("2026-05-23T12:00:00+00:00");
  });

  it("renders summary card with composite, pass rate, and cost", () => {
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    // The same value (0.642, 75%, $3.42, 310 ms) appears both in the
    // summary card and (in raw form) in the JSON pre block; check that
    // at least one match exists for each.
    expect(screen.getAllByText("0.642").length).toBeGreaterThan(0); // composite
    expect(screen.getByText("75%")).toBeInTheDocument(); // pass rate (formatted)
    expect(screen.getByText(/\$3\.42/)).toBeInTheDocument(); // cost (USD-formatted)
    expect(screen.getByText("310 ms")).toBeInTheDocument(); // latency (formatted)
    expect(screen.getAllByText("7").length).toBeGreaterThan(0); // iteration
  });

  it("renders the highlighted JSON pre block", () => {
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    const pre = screen.getByTestId("report-json");
    expect(pre).toBeInTheDocument();
    // The highlighter wraps keys in slate-700 spans.
    expect(pre.innerHTML).toContain("text-slate-700");
    // Numbers in indigo-700.
    expect(pre.innerHTML).toContain("text-indigo-700");
    // Source fields render somewhere in the highlighted text.
    expect(pre.textContent).toContain("composite_mean");
    expect(pre.textContent).toContain("0.642");
  });

  it("Back to Run navigates back to /run", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run" element={<div data-testid="run-landed">run page</div>} />
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    await user.click(screen.getByTestId("back-to-run"));
    expect(screen.getByTestId("run-landed")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", () => {
    mocks.useReportByTimestamp.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Boom — report_not_found"),
    });
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    expect(screen.getByTestId("report-detail-error")).toHaveTextContent(
      /report_not_found/,
    );
  });

  it("renders Run when 'Back to Run' is clicked, with the real Run page", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        "/run/reports/2026-05-23T12:00:00+00:00",
        <Routes>
          <Route path="/run" element={<Run />} />
          <Route path="/run/reports/:timestamp" element={<RunReportDetail />} />
        </Routes>,
      ),
    );
    await user.click(screen.getByTestId("back-to-run"));
    // Run.tsx header: "Live run dashboard"
    expect(screen.getByText(/Live run dashboard/i)).toBeInTheDocument();
  });
});

describe("highlightJson", () => {
  it("wraps keys, strings, and numbers in colored spans", () => {
    const html = highlightJson({ name: "alpha", count: 7, ok: true, ref: null });
    expect(html).toContain('text-slate-700');
    expect(html).toContain('text-emerald-700');
    expect(html).toContain('text-indigo-700');
    expect(html).toContain('text-violet-700');
  });

  it("escapes HTML characters before highlighting", () => {
    const html = highlightJson({ q: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles undefined values by returning empty string", () => {
    expect(highlightJson(undefined)).toBe("");
  });
});
