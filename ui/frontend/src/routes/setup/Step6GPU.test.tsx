import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, ProbeResult } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useProbe: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Step6GPU } from "./Step6GPU";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function makeConfig(overrides: Partial<BratanConfig["models"]> = {}): BratanConfig {
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
      ...overrides,
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

const sampleProbe: ProbeResult = {
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

describe("Step6GPU VRAM math", () => {
  beforeEach(() => {
    mocks.useProbe.mockReturnValue({
      data: sampleProbe,
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    });
  });

  it("only counts models that are toggled ON", () => {
    // Default new-user defaults: small embed (130) + reranker (2300) +
    // Qwen 7B (5000) = 7430 MB.
    render(withProviders(<Step6GPU config={makeConfig()} />));
    expect(screen.getByTestId("vram-total-mb")).toHaveTextContent("7430 MB");
  });

  it("sums zero when every local toggle is off", () => {
    render(
      withProviders(
        <Step6GPU
          config={makeConfig({
            use_local_embedding: false,
            use_local_reranker: false,
            use_local_prejudge: false,
          })}
        />,
      ),
    );
    expect(screen.queryByTestId("vram-breakdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vram-warning")).not.toBeInTheDocument();
  });

  it("excludes pre-judge when its toggle is off", () => {
    render(
      withProviders(
        <Step6GPU
          config={makeConfig({
            use_local_embedding: true,
            use_local_reranker: true,
            use_local_prejudge: false,
          })}
        />,
      ),
    );
    // 130 (small embed) + 2300 (reranker) = 2430.
    expect(screen.getByTestId("vram-total-mb")).toHaveTextContent("2430 MB");
    expect(screen.queryByTestId("vram-row-prejudge")).not.toBeInTheDocument();
  });

  it("scales up for bge-large + Qwen-14B and warns past 16 GB", () => {
    render(
      withProviders(
        <Step6GPU
          config={makeConfig({
            embedding_model: "BAAI/bge-large-en-v1.5",
            prejudge_model: "Qwen/Qwen2.5-14B-Instruct-AWQ",
          })}
        />,
      ),
    );
    // 1300 (large embed) + 2300 (reranker) + 20000 (14B) = 23600.
    expect(screen.getByTestId("vram-total-mb")).toHaveTextContent("23600 MB");
    expect(screen.getByTestId("vram-warning")).toBeInTheDocument();
  });

  it("shows per-model breakdown rows for each enabled component", () => {
    render(withProviders(<Step6GPU config={makeConfig()} />));
    expect(screen.getByTestId("vram-row-embedding")).toBeInTheDocument();
    expect(screen.getByTestId("vram-row-reranker")).toBeInTheDocument();
    expect(screen.getByTestId("vram-row-prejudge")).toBeInTheDocument();
    expect(screen.getByTestId("vram-mb-embedding")).toHaveTextContent("130 MB");
    expect(screen.getByTestId("vram-mb-reranker")).toHaveTextContent("2300 MB");
    expect(screen.getByTestId("vram-mb-prejudge")).toHaveTextContent("5000 MB");
  });

  it("renders the 'Detect GPU now' button", () => {
    render(withProviders(<Step6GPU config={makeConfig()} />));
    expect(
      screen.getByRole("button", { name: /detect gpu now/i }),
    ).toBeInTheDocument();
  });

  it("invokes the probe mutation when 'Detect GPU now' is clicked", async () => {
    const probeMutate = vi.fn();
    mocks.useProbe.mockReturnValue({
      data: sampleProbe,
      mutate: probeMutate,
      isPending: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<Step6GPU config={makeConfig()} />));
    // The mount-effect already triggered one call; clicking should add another.
    const before = probeMutate.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /detect gpu now/i }));
    expect(probeMutate.mock.calls.length).toBe(before + 1);
  });

  it("renders the VRAM warning when wanted MB exceeds detected total", () => {
    render(
      withProviders(
        <Step6GPU
          config={makeConfig({
            embedding_model: "BAAI/bge-large-en-v1.5",
            prejudge_model: "Qwen/Qwen2.5-14B-Instruct-AWQ",
          })}
        />,
      ),
    );
    const warning = screen.getByTestId("vram-warning");
    expect(warning.textContent).toMatch(/VRAM may be insufficient/i);
    expect(warning.textContent).toMatch(/23600 MB/);
    expect(warning.textContent).toMatch(/16303 MB/);
  });

  it("does not render the VRAM warning when fit is fine", () => {
    render(withProviders(<Step6GPU config={makeConfig()} />));
    expect(screen.queryByTestId("vram-warning")).not.toBeInTheDocument();
  });

  it("displays GPU name + VRAM total in the stat tiles", () => {
    render(withProviders(<Step6GPU config={makeConfig()} />));
    expect(screen.getByText(/NVIDIA RTX 4080/)).toBeInTheDocument();
    expect(screen.getByText(/16303 MB/)).toBeInTheDocument();
  });
});
