import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig, SeedListResponse } from "@/api/types";

// Mode-tab switch — does typing in one mode survive a round-trip through
// the other mode? Authoring.tsx renders one of two wizards (CaseWizard or
// CaseWizardFromCorpus) based on local `mode` state. Switching tabs
// unmounts the inactive wizard entirely, which drops its internal
// `useState` draft. The autosave on disk (every 2s) may catch some cases,
// but a user who types quickly and toggles tabs in less than 2s would
// lose their work silently. This audit row (Section 4 row 8) asserts the
// expected UX: the textarea text survives a tab round-trip.
//
// Mocks follow the conventions in sibling Authoring.test.tsx — every
// child hook mocked at @/api/hooks, no real network, real QueryClient.

const mocks = vi.hoisted(() => ({
  useConfig: vi.fn(),
  useSeedList: vi.fn(),
  useCorpusFiles: vi.fn(),
  useCorpusPassagesPaginated: vi.fn(),
  useIngestStatus: vi.fn(),
  useStartIngest: vi.fn(),
  useSeedDrafts: vi.fn(),
  useDeleteDraft: vi.fn(),
  useSaveDraft: vi.fn(),
  useSeedSave: vi.fn(),
  useSeedValidate: vi.fn(),
  useCorpusSearch: vi.fn(),
  useGeneratedFiles: vi.fn(),
  useGeneratedCases: vi.fn(),
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

function emptySeedList(): SeedListResponse {
  return { cases: [], target_n: 50, progress: 0 };
}

beforeEach(() => {
  mocks.useConfig.mockReturnValue({ data: sampleConfig, isLoading: false });
  mocks.useSeedList.mockReturnValue({ data: emptySeedList(), isLoading: false });
  mocks.useCorpusFiles.mockReturnValue({ data: [], isLoading: false, isError: false });
  mocks.useCorpusPassagesPaginated.mockReturnValue({
    data: null,
    isLoading: false,
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
  mocks.useGeneratedFiles.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
  mocks.useGeneratedCases.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
});

describe("Authoring — mode-tab switch preserves draft", () => {
  // The from-question wizard has a top-level Question textarea that's
  // always present (no anchor gate). Type into it, toggle to from-corpus,
  // toggle back, and assert the text survived. If the textarea is empty,
  // the test reveals the silent-data-loss bug Section 4 row 8 flagged.
  it("preserves typed question when switching from-question -> from-corpus -> from-question", async () => {
    const user = userEvent.setup();
    render(withProviders(<Authoring />));

    // Default is from-corpus per audit row "defaults to from-corpus".
    // Switch to from-question so the always-on Question textarea is in
    // the DOM.
    await user.click(screen.getByRole("tab", { name: /from a question/i }));
    expect(
      screen.getByRole("tab", { name: /from a question/i }),
    ).toHaveAttribute("aria-selected", "true");

    const question = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    await user.type(question, "what is X?");
    expect(question.value).toBe("what is X?");

    // Switch to from-corpus — the from-question wizard unmounts.
    await user.click(screen.getByRole("tab", { name: /from the corpus/i }));
    expect(
      screen.getByRole("tab", { name: /from the corpus/i }),
    ).toHaveAttribute("aria-selected", "true");
    // The Question label is now gone (from-corpus only shows it after a
    // passage is anchored; the file list is empty so no anchor is
    // possible). This proves the wizard actually unmounted.
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();

    // Switch back to from-question.
    await user.click(screen.getByRole("tab", { name: /from a question/i }));
    const questionAfter = screen.getByLabelText(
      /^question/i,
    ) as HTMLTextAreaElement;

    // TODO: prod bug — author drafts silently lost on mode-tab switch;
    // fix via useAutoSaveStep or zustand store. The wizard remounts with
    // a fresh `useState(newDraft())`, so the in-flight question is gone.
    expect(questionAfter.value).toBe("what is X?");
  });

  // Reverse direction — same class of bug, asymmetric components though,
  // so worth its own assertion. Note: in from-corpus the Question
  // textarea is only mounted *after* a passage is anchored, which
  // requires the file list to be non-empty and a passage to be selected.
  // We set up enough fixture data to make the textarea mount, type into
  // it, toggle, toggle back, and re-anchor.
  it("preserves typed question when switching from-corpus -> from-question -> from-corpus", async () => {
    mocks.useCorpusFiles.mockReturnValue({
      data: [
        {
          path: "doc.md",
          size_bytes: 1024,
          modified: "2026-05-01T00:00:00Z",
          ingested: true,
          n_chunks: 12,
        },
      ],
      isLoading: false,
      isError: false,
    });
    mocks.useCorpusPassagesPaginated.mockReturnValue({
      data: {
        passages: [
          {
            path: "doc.md",
            line_start: 1,
            line_end: 10,
            content: "Article 3.1. Each constructor shall declare two drivers.",
            score: null,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
        window_lines: 10,
      },
      isLoading: false,
      isError: false,
      error: null,
    });

    const user = userEvent.setup();
    render(withProviders(<Authoring />));

    // Already on from-corpus by default. Anchor a passage so the
    // Question textarea mounts. The passage-button testid is the only
    // selector that's unique once anchored (the anchored-passage banner
    // also renders the passage content).
    await user.click(screen.getByRole("button", { name: /doc\.md/ }));
    await user.click(screen.getByTestId("from-corpus-passage"));
    const question = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    await user.type(question, "what is X?");
    expect(question.value).toBe("what is X?");

    // Toggle to from-question.
    await user.click(screen.getByRole("tab", { name: /from a question/i }));
    expect(
      screen.getByRole("tab", { name: /from a question/i }),
    ).toHaveAttribute("aria-selected", "true");

    // Toggle back to from-corpus. The wizard remounts; the anchor is
    // gone (so we'd have to re-pick), AND the draft text is gone.
    await user.click(screen.getByRole("tab", { name: /from the corpus/i }));
    // Re-anchor the same passage so the Question textarea is in the DOM
    // again. Even though the user picked the same passage, their
    // earlier typed text is what we care about preserving.
    await user.click(screen.getByTestId("from-corpus-passage"));
    const questionAfter = screen.getByLabelText(
      /^question/i,
    ) as HTMLTextAreaElement;

    // TODO: prod bug — author drafts silently lost on mode-tab switch;
    // fix via useAutoSaveStep or zustand store. CaseWizardFromCorpus's
    // newDraft() runs fresh on remount.
    expect(questionAfter.value).toBe("what is X?");
  });
});
