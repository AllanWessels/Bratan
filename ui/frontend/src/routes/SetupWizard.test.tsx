import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
}));

vi.mock("@/api/hooks", () => mocks);

import { SetupWizard } from "./SetupWizard";

function withProviders(ui: React.ReactNode, initialEntries: string[] = ["/setup/1"]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/setup/:step" element={ui} />
          <Route path="/setup" element={ui} />
          <Route path="/authoring" element={<div data-testid="authoring-mount" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

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
  setup_completed: false,
  setup_completed_at: null,
};

const sampleSetupState: SetupState = {
  config_exists: true,
  setup_completed: false,
  current_step: 1,
  total_steps: 8,
  completed_steps: [1, 2],
};

beforeEach(() => {
  mocks.useSetupState.mockReturnValue({ data: sampleSetupState, isLoading: false });
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useFinishSetup.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(sampleConfig),
    isPending: false,
    isError: false,
  });
  mocks.useSaveStep.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
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
    isError: false,
  });
  mocks.useTestAnthropic.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
  });
  mocks.useTestVLLM.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
  });
});

describe("SetupWizard", () => {
  it("renders Step 1 by default when URL is /setup/1", () => {
    render(withProviders(<SetupWizard />, ["/setup/1"]));
    expect(screen.getByText(/Step 1 of 8/)).toBeInTheDocument();
    expect(screen.getAllByText(/Project basics/i).length).toBeGreaterThan(0);
  });

  it("renders the correct step component for /setup/2", () => {
    render(withProviders(<SetupWizard />, ["/setup/2"]));
    expect(screen.getByText(/Step 2 of 8/)).toBeInTheDocument();
    // Step 2 includes "Vector database"
    expect(screen.getAllByText(/Vector database/i).length).toBeGreaterThan(0);
  });

  it("renders Step 8 for /setup/8 and shows 'Finish setup' on Next", () => {
    render(withProviders(<SetupWizard />, ["/setup/8"]));
    expect(screen.getByText(/Step 8 of 8/)).toBeInTheDocument();
    expect(screen.getByTestId("wizard-next").textContent).toMatch(/Finish setup/i);
  });

  it("Previous button is disabled on step 1", () => {
    render(withProviders(<SetupWizard />, ["/setup/1"]));
    expect(screen.getByTestId("wizard-prev")).toBeDisabled();
  });

  it("Previous button is enabled on step 2+", () => {
    render(withProviders(<SetupWizard />, ["/setup/3"]));
    expect(screen.getByTestId("wizard-prev")).not.toBeDisabled();
  });

  it("Next navigates from step 2 to step 3", async () => {
    const user = userEvent.setup();
    render(withProviders(<SetupWizard />, ["/setup/2"]));
    expect(screen.getByText(/Step 2 of 8/)).toBeInTheDocument();
    await user.click(screen.getByTestId("wizard-next"));
    expect(screen.getByText(/Step 3 of 8/)).toBeInTheDocument();
  });

  it("Previous navigates from step 3 to step 2", async () => {
    const user = userEvent.setup();
    render(withProviders(<SetupWizard />, ["/setup/3"]));
    await user.click(screen.getByTestId("wizard-prev"));
    expect(screen.getByText(/Step 2 of 8/)).toBeInTheDocument();
  });

  it("Skip to defaults calls finishSetup then redirects to /authoring", async () => {
    const finishMutate = vi.fn().mockResolvedValue(sampleConfig);
    mocks.useFinishSetup.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: finishMutate,
      isPending: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<SetupWizard />, ["/setup/1"]));
    await user.click(screen.getByTestId("skip-to-defaults"));
    expect(finishMutate).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("authoring-mount")).toBeInTheDocument();
    });
  });

  it("renders the step indicator with the active step highlighted", () => {
    render(withProviders(<SetupWizard />, ["/setup/4"]));
    // The active step's pill should match step 4
    expect(screen.getByText(/Step 4 of 8/)).toBeInTheDocument();
  });

  it("clamps an out-of-range URL step to 1", () => {
    render(withProviders(<SetupWizard />, ["/setup/99"]));
    expect(screen.getByText(/Step 1 of 8/)).toBeInTheDocument();
  });
});
