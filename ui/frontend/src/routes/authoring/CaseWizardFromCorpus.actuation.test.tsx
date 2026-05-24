import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CorpusFile,
  CorpusPassagesResponse,
  SeedSaveResponse,
  SeedValidateResponse,
} from "@/api/types";

const mocks = vi.hoisted(() => ({
  useCorpusFiles: vi.fn(),
  useCorpusPassagesPaginated: vi.fn(),
  useSaveDraft: vi.fn(),
  useSeedSave: vi.fn(),
  useSeedValidate: vi.fn(),
  useStartIngest: vi.fn(),
  useIngestStatus: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { CaseWizardFromCorpus } from "./CaseWizardFromCorpus";
import { useUIStore } from "@/store/uiStore";

/**
 * Drives every interactive control on the "From the corpus" authoring page.
 *
 * The earlier round of tests rendered only the post-anchor enabled state and
 * never exercised the disabled→enabled transition. As a result, when the
 * pre-anchor UI silently disabled the textareas (and looked like a regular
 * editable textarea), the bug shipped: users couldn't type and there was no
 * visual signal as to why. This file covers:
 *
 *   - The disabled state of every input *before* a passage is anchored
 *     (the textareas, category select, and notes textarea must not exist
 *      yet — they are gated behind the empty-state panel).
 *   - The Save button is disabled in the pre-anchor state.
 *   - After anchoring, every input (question, ground-truth, category,
 *     notes) accepts user input and Save fires with the typed payload.
 */

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function files(): CorpusFile[] {
  return [
    {
      path: "fia-2026-regs.md",
      size_bytes: 1024,
      modified: "2026-05-01T00:00:00Z",
      ingested: true,
      n_chunks: 12,
    },
  ];
}

function passagesResp(): CorpusPassagesResponse {
  return {
    passages: [
      {
        path: "fia-2026-regs.md",
        line_start: 1,
        line_end: 10,
        content:
          "Article 3.1. Each constructor shall declare two drivers no later than 1 January.",
        score: null,
      },
      {
        path: "fia-2026-regs.md",
        line_start: 11,
        line_end: 20,
        content: "Article 3.2. Wheelbase shall not exceed 3600mm.",
        score: null,
      },
    ],
    total: 2,
    offset: 0,
    limit: 20,
    window_lines: 10,
  };
}

function validResult(): SeedValidateResponse {
  return {
    passages_in_top_k: true,
    answer_text_in_passages: true,
    top_k_match_count: 1,
    top_k_searched: 5,
    pipeline_score: null,
    pipeline_answer: null,
    pipeline_retrieved: null,
    warnings: [],
  };
}

function saveResp(): SeedSaveResponse {
  return {
    ok: true,
    case: {
      id: "case-001",
      question: "q",
      ground_truth: "a",
      source_passages: [],
      failure_category: "straightforward",
      notes: "",
      hypothesis: null,
      created_at: "2026-05-24T10:00:00Z",
      created_by: "human",
    },
    total_cases: 1,
    target_n: 50,
  };
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
  // jsdom doesn't implement scrollIntoView; the "Highlight passage list" CTA
  // calls it, so polyfill it here.
  Element.prototype.scrollIntoView = vi.fn();
  mocks.useCorpusFiles.mockReturnValue({
    data: files(),
    isLoading: false,
    isError: false,
  });
  mocks.useCorpusPassagesPaginated.mockReturnValue({
    data: passagesResp(),
    isLoading: false,
    isError: false,
    error: null,
  });
  mocks.useSaveDraft.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn() });
  mocks.useSeedSave.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(saveResp()),
    isPending: false,
  });
  mocks.useSeedValidate.mockReturnValue({
    mutate: vi.fn(),
    reset: vi.fn(),
    data: validResult(),
    isPending: false,
    isError: false,
    error: null,
  });
  mocks.useStartIngest.mockReturnValue({
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

describe("CaseWizardFromCorpus actuation — pre-anchor disabled state", () => {
  it("the question textarea is not in the DOM before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();
  });

  it("the ground-truth textarea is not in the DOM before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(
      screen.queryByLabelText(/ground-truth answer/i),
    ).not.toBeInTheDocument();
  });

  it("the category select is not in the DOM before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(screen.queryByLabelText(/category/i)).not.toBeInTheDocument();
  });

  it("the notes textarea is not in the DOM before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(screen.queryByLabelText(/^notes/i)).not.toBeInTheDocument();
  });

  it("the Save Case button is disabled before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(
      screen.getByRole("button", { name: /save case/i }),
    ).toBeDisabled();
  });
});

describe("CaseWizardFromCorpus actuation — post-anchor every input", () => {
  it("typing into the question textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const q = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    await user.type(q, "What does the corpus say?");
    expect(q.value).toBe("What does the corpus say?");
  });

  it("typing into the ground-truth textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const g = screen.getByLabelText(
      /ground-truth answer/i,
    ) as HTMLTextAreaElement;
    await user.type(g, "Two drivers per constructor.");
    expect(g.value).toBe("Two drivers per constructor.");
  });

  it("the category <select> offers SME-friendly labels and persists the choice", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const cat = screen.getByLabelText(/category/i) as HTMLSelectElement;
    await user.selectOptions(cat, "straightforward");
    expect(cat.value).toBe("straightforward");
    // The description appears once a value is chosen.
    expect(screen.getByTestId("category-description")).toBeInTheDocument();
  });

  it("typing into the notes textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const n = screen.getByLabelText(/^notes/i) as HTMLTextAreaElement;
    await user.type(n, "Edge case: declared mid-season.");
    expect(n.value).toBe("Edge case: declared mid-season.");
  });

  it("Save Case sends the typed question, ground_truth, category, notes, and passage", async () => {
    const saveAsync = vi.fn().mockResolvedValue(saveResp());
    mocks.useSeedSave.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: saveAsync,
      isPending: false,
    });
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(
      screen.getByLabelText(/^question/i),
      "Drivers per constructor?",
    );
    await user.type(
      screen.getByLabelText(/ground-truth answer/i),
      "Two.",
    );
    await user.type(screen.getByLabelText(/^notes/i), "From the article.");
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    // Validation already returns a passing result in this suite's beforeEach,
    // so once the category is chosen Save is enabled.
    const saveBtn = screen.getByRole("button", { name: /save case/i });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const [arg] = saveAsync.mock.calls[0];
    expect(arg.question).toBe("Drivers per constructor?");
    expect(arg.ground_truth).toBe("Two.");
    expect(arg.notes).toBe("From the article.");
    expect(arg.failure_category).toBe("straightforward");
    expect(arg.passages).toEqual([
      { path: "fia-2026-regs.md", line_start: 1, line_end: 10 },
    ]);
  });
});
