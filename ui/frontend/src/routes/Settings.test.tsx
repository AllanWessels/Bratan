import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  useSaveStep: vi.fn(),
  useProbe: vi.fn(),
  useTestVectorDB: vi.fn(),
  useTestAnthropic: vi.fn(),
  useTestVLLM: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Settings } from "./Settings";

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
  project: { project_name: "settings-test", corpus_path: "./corpus", seed_target_n: 50 },
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

beforeEach(() => {
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
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
});

describe("Settings", () => {
  it("renders the sidebar with all 8 sections", () => {
    render(withProviders(<Settings />));
    for (const label of [
      /Project/i,
      /Vector DB/i,
      /Models/i,
      /Cost ceilings/i,
      /Seed target/i,
      /^GPU$/i,
      /Stopping criteria/i,
      /Judge weights/i,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("renders Step1ProjectBasics (the Project section) by default", () => {
    render(withProviders(<Settings />));
    // Step1ProjectBasics renders fields with these labels:
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/corpus path/i)).toBeInTheDocument();
  });

  it("populates inputs from config", () => {
    render(withProviders(<Settings />));
    expect(screen.getByLabelText(/project name/i)).toHaveValue("settings-test");
  });

  it("switches the active section when a nav button is clicked", async () => {
    const user = userEvent.setup();
    render(withProviders(<Settings />));
    await user.click(screen.getByRole("button", { name: /Cost ceilings/i }));
    expect(screen.getByLabelText(/usd per run/i)).toBeInTheDocument();
  });

  it("links back to /authoring", () => {
    render(withProviders(<Settings />));
    const back = screen.getByRole("link", { name: /back/i });
    expect(back).toHaveAttribute("href", "/authoring");
  });
});
