import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, SeedListResponse } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
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
}));

vi.mock("@/api/hooks", () => mocks);

import { Authoring } from "./Authoring";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const sampleConfig: BratanConfig = {
  project: { project_name: "bratan", corpus_path: "./corpus", seed_target_n: 50 },
  vector_db: { adapter: "chroma", chroma_path: "./.chroma", chroma_collection: "corpus" },
  models: {
    anthropic_api_key: "",
    oracle_model: "claude-sonnet-4-20250514",
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

function makeSeedList(count: number, target = 50): SeedListResponse {
  return {
    cases: Array.from({ length: count }).map((_, i) => ({
      id: `case-${i}`,
      question: `q-${i}`,
      ground_truth: "a",
      source_passages: [],
      failure_category: "straightforward",
      notes: "",
      hypothesis: null,
      created_at: "2026-05-23T10:00:00Z",
      created_by: "human" as const,
    })),
    target_n: target,
    progress: count / target,
  };
}

beforeEach(() => {
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useSeedList.mockReturnValue({ data: makeSeedList(5), isLoading: false });
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
});

describe("Authoring", () => {
  it("renders the Bratan brand heading", () => {
    render(withProviders(<Authoring />));
    expect(screen.getAllByText(/Bratan/i).length).toBeGreaterThan(0);
  });

  it("renders the progress bar reflecting cases / target_n", () => {
    render(withProviders(<Authoring />));
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "50");
    expect(screen.getByText(/Progress 5 \/ 50/)).toBeInTheDocument();
  });

  it("does NOT render the celebratory banner below target", () => {
    render(withProviders(<Authoring />));
    expect(screen.queryByText(/reached the target/i)).not.toBeInTheDocument();
  });

  it("renders the celebratory banner when cases >= target_n", () => {
    mocks.useSeedList.mockReturnValue({
      data: makeSeedList(60, 50),
      isLoading: false,
    });
    render(withProviders(<Authoring />));
    expect(screen.getByText(/reached the target of 50 cases/i)).toBeInTheDocument();
  });

  it("shows links to Run and Settings", () => {
    render(withProviders(<Authoring />));
    expect(screen.getByRole("link", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });
});
