import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, SetupState } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useSetupState: vi.fn(),
  useConfig: vi.fn(),
  useFinishSetup: vi.fn(),
  useSaveStep: vi.fn(),
  useProbe: vi.fn(),
  useTestVectorDB: vi.fn(),
  useTestAnthropic: vi.fn(),
  useTestVLLM: vi.fn(),
  useSeedList: vi.fn(),
  useCorpusFiles: vi.fn(),
  useIngestStatus: vi.fn(),
  useStartIngest: vi.fn(),
  useSeedDrafts: vi.fn(),
  useDeleteDraft: vi.fn(),
  useSaveDraft: vi.fn(),
  useSeedSave: vi.fn(),
  useSeedValidate: vi.fn(),
  useCorpusSearch: vi.fn(),
  useLatestReport: vi.fn(),
  useReportHistory: vi.fn(),
  useLoopStatus: vi.fn(),
  useLoopStream: vi.fn(),
  useStartLoop: vi.fn(),
  useStopLoop: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import App from "./App";

const sampleConfig: BratanConfig = {
  project: { project_name: "bratan", corpus_path: "./corpus", seed_target_n: 50 },
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
  setup_completed: true,
  setup_completed_at: "2026-05-01T00:00:00Z",
};

const completedState: SetupState = {
  config_exists: true,
  setup_completed: true,
  current_step: 8,
  total_steps: 8,
  completed_steps: [1, 2, 3, 4, 5, 6, 7, 8],
};

const incompleteState: SetupState = {
  config_exists: true,
  setup_completed: false,
  current_step: 2,
  total_steps: 8,
  completed_steps: [1],
};

function withProviders(ui: React.ReactNode, initial = "/") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.useSetupState.mockReturnValue({ data: completedState, isLoading: false });
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useFinishSetup.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mocks.useSaveStep.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mocks.useProbe.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
  });
  mocks.useTestVectorDB.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
  });
  mocks.useTestAnthropic.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
  });
  mocks.useTestVLLM.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
  });
  mocks.useSeedList.mockReturnValue({
    data: { cases: [], target_n: 50, progress: 0 },
    isLoading: false,
  });
  mocks.useCorpusFiles.mockReturnValue({ data: [], isLoading: false, isError: false });
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
  mocks.useStartIngest.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useSeedDrafts.mockReturnValue({ data: [], isLoading: false });
  mocks.useDeleteDraft.mockReturnValue({ mutate: vi.fn() });
  mocks.useSaveDraft.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn() });
  mocks.useSeedSave.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  mocks.useSeedValidate.mockReturnValue({
    mutate: vi.fn(),
    reset: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useCorpusSearch.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
    error: null,
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

describe("App routing", () => {
  it("redirects / to /authoring when setup is complete", async () => {
    render(withProviders(<App />, "/"));
    await waitFor(() => {
      // Authoring page renders the seed-case progress header.
      expect(screen.getAllByText(/Bratan/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/Seed case authoring/i)).toBeInTheDocument();
    });
  });

  it("redirects / to /setup/<current_step> when setup is incomplete", async () => {
    mocks.useSetupState.mockReturnValue({ data: incompleteState, isLoading: false });
    render(withProviders(<App />, "/"));
    await waitFor(() => {
      expect(screen.getByText(/Step 2 of 8/)).toBeInTheDocument();
    });
  });

  it("mounts SetupWizard at /setup", () => {
    render(withProviders(<App />, "/setup"));
    expect(screen.getByText(/Setup wizard/i)).toBeInTheDocument();
  });

  it("mounts SetupWizard at /setup/3", () => {
    render(withProviders(<App />, "/setup/3"));
    expect(screen.getByText(/Step 3 of 8/)).toBeInTheDocument();
  });

  it("mounts Authoring at /authoring", () => {
    render(withProviders(<App />, "/authoring"));
    expect(screen.getByText(/Seed case authoring/i)).toBeInTheDocument();
  });

  it("mounts Run at /run", () => {
    render(withProviders(<App />, "/run"));
    expect(screen.getByText(/Live run dashboard/i)).toBeInTheDocument();
  });

  it("mounts Settings at /settings", () => {
    render(withProviders(<App />, "/settings"));
    // Settings sidebar heading
    expect(screen.getByRole("heading", { name: /^Settings$/i })).toBeInTheDocument();
  });

  it("falls back to NotFound for unknown routes", () => {
    render(withProviders(<App />, "/this/does/not/exist"));
    expect(screen.getByRole("heading", { name: /not found/i })).toBeInTheDocument();
  });

  it("redirects to /setup when the setup-state query errors", async () => {
    mocks.useSetupState.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(withProviders(<App />, "/"));
    await waitFor(() => {
      expect(screen.getByText(/Setup wizard/i)).toBeInTheDocument();
    });
  });
});
