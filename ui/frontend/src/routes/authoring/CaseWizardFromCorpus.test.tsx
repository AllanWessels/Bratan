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
    {
      path: "another-doc.md",
      size_bytes: 512,
      modified: "2026-05-01T00:00:00Z",
      ingested: false,
      n_chunks: null,
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
    data: null,
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

describe("CaseWizardFromCorpus", () => {
  it("renders the file rail with the corpus files", () => {
    render(withProviders(<CaseWizardFromCorpus />));
    expect(screen.getByText(/fia-2026-regs\.md/)).toBeInTheDocument();
    expect(screen.getByText(/another-doc\.md/)).toBeInTheDocument();
  });

  it("prompts to pick a file before showing any passages", () => {
    render(withProviders(<CaseWizardFromCorpus />));
    expect(screen.getByText(/select a file on the left/i)).toBeInTheDocument();
  });

  it("loads passages after a file is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(
      screen.getByText(/Article 3.1. Each constructor shall declare/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Article 3.2. Wheelbase/)).toBeInTheDocument();
  });

  it("renders the empty-state panel (not the textareas) when no passage is anchored", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    // The locked card 2 shows the explanatory empty-state, not textareas.
    expect(screen.getByTestId("empty-state-no-anchor")).toBeInTheDocument();
    expect(
      screen.getByText(/click a passage above to start writing your case/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/ground-truth answer/i),
    ).not.toBeInTheDocument();
  });

  it("anchors the selected passage and enables the form", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    // Anchored banner shows up with the passage text
    expect(screen.getByTestId("anchored-passage")).toBeInTheDocument();
    expect(screen.getByLabelText(/^question/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/ground-truth answer/i)).not.toBeDisabled();
  });

  it("renders the failure category dropdown with SME-friendly labels", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const select = screen.getByLabelText(/category/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toContain("Direct question");
    expect(options).toContain("Different words, same idea");
    expect(options).toContain("Not in the corpus");
    expect(options).not.toContain("Paraphrase Brittleness");
  });

  it("shows the category description below the dropdown when a value is picked", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    expect(screen.getByTestId("category-description")).toHaveTextContent(
      /A regular question with a clear answer/i,
    );
  });

  it("Save is disabled until validation passes and a category is chosen", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    expect(screen.getByRole("button", { name: /save case/i })).toBeDisabled();
  });

  it("Save calls seedSave with the anchored passage in source_passages", async () => {
    const saveAsync = vi.fn().mockResolvedValue(saveResp());
    mocks.useSeedSave.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: saveAsync,
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
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(
      screen.getByLabelText(/^question/i),
      "How many drivers must each constructor declare?",
    );
    await user.type(
      screen.getByLabelText(/ground-truth answer/i),
      "Two drivers, by 1 January.",
    );
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      expect(saveAsync).toHaveBeenCalledTimes(1);
    });
    const [arg] = saveAsync.mock.calls[0];
    expect(arg.passages).toEqual([
      { path: "fia-2026-regs.md", line_start: 1, line_end: 10 },
    ]);
    expect(arg.failure_category).toBe("straightforward");
  });

  it("keeps the file selected and clears per-case fields after save", async () => {
    const saveAsync = vi.fn().mockResolvedValue(saveResp());
    mocks.useSeedSave.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: saveAsync,
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
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(screen.getByLabelText(/^question/i), "How many?");
    await user.type(
      screen.getByLabelText(/ground-truth answer/i),
      "Two.",
    );
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      expect(saveAsync).toHaveBeenCalled();
    });
    // After save the per-case fields are cleared by reverting to the locked
    // empty-state (no passage anchored). The file rail still marks the file
    // as selected so the SME can author another case.
    expect(screen.getByTestId("empty-state-no-anchor")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();
    // Anchored banner is cleared because the passage is reset.
    expect(screen.queryByTestId("anchored-passage")).not.toBeInTheDocument();
  });

  it("pushes a success toast after save", async () => {
    mocks.useSeedValidate.mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      data: validResult(),
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(screen.getByLabelText(/^question/i), "How many?");
    await user.type(
      screen.getByLabelText(/ground-truth answer/i),
      "Two.",
    );
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(
        toasts.some(
          (t) => t.variant === "success" && t.message.includes("1 / 50"),
        ),
      ).toBe(true);
    });
  });

  it("pushes an error toast when save fails (e.g. duplicate question)", async () => {
    const saveAsync = vi.fn().mockRejectedValue(new Error("Duplicate question"));
    mocks.useSeedSave.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: saveAsync,
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
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(screen.getByLabelText(/^question/i), "Dup?");
    await user.type(
      screen.getByLabelText(/ground-truth answer/i),
      "Two.",
    );
    await user.selectOptions(
      screen.getByLabelText(/category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      const err = toasts.find((t) => t.variant === "error");
      expect(err).toBeDefined();
      expect(err!.message).toBe("Duplicate question");
    });
  });
});

describe("CaseWizardFromCorpus — disabled→enabled transition", () => {
  // Polyfill scrollIntoView in jsdom (the production code calls it when the
  // "Highlight passage list" CTA is clicked).
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows the locked empty-state panel and hides the textareas before anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(screen.getByTestId("empty-state-no-anchor")).toBeInTheDocument();
    expect(
      screen.getByText(/click a passage above to start writing your case/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/ground-truth answer/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the Save button disabled while the empty state is showing", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    expect(
      screen.getByRole("button", { name: /save case/i }),
    ).toBeDisabled();
  });

  it('"Highlight passage list" toggles the pulse class on the list and clears it later', async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    const list = screen.getByTestId("from-corpus-passage-list");
    expect(list).toHaveAttribute("data-pulse", "false");
    await user.click(screen.getByTestId("highlight-passage-list"));
    // The pulse flag is on immediately and the pulse class is applied.
    expect(list).toHaveAttribute("data-pulse", "true");
    expect(list.className).toMatch(/animate-pulse/);
    // It clears itself after ~1.5s without any further user action.
    await waitFor(
      () => {
        expect(list).toHaveAttribute("data-pulse", "false");
      },
      { timeout: 3000 },
    );
  });

  it("clicking a passage removes the empty state and renders enabled textareas", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    // Empty state first.
    expect(screen.getByTestId("empty-state-no-anchor")).toBeInTheDocument();
    await user.click(screen.getByText(/Article 3.1./));
    // Empty state gone; textareas present and enabled.
    expect(
      screen.queryByTestId("empty-state-no-anchor"),
    ).not.toBeInTheDocument();
    const q = screen.getByLabelText(/^question/i);
    const g = screen.getByLabelText(/ground-truth answer/i);
    expect(q).toBeInTheDocument();
    expect(g).toBeInTheDocument();
    expect(q).not.toBeDisabled();
    expect(g).not.toBeDisabled();
  });

  it("typed values land in the question and ground-truth fields after anchoring", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const q = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    const g = screen.getByLabelText(
      /ground-truth answer/i,
    ) as HTMLTextAreaElement;
    await user.type(q, "How many drivers per constructor?");
    await user.type(g, "Two.");
    expect(q.value).toBe("How many drivers per constructor?");
    expect(g.value).toBe("Two.");
  });

  it("the anchored-passage banner displays the selected passage with a Change button", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    const banner = screen.getByTestId("anchored-passage");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/fia-2026-regs\.md/);
    expect(banner).toHaveTextContent(/L1–10/);
    expect(screen.getByTestId("change-anchor")).toBeInTheDocument();
  });

  it("clicking Change clears the textareas and re-shows the empty state", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    // Type a value into the question field, then re-anchor.
    await user.type(screen.getByLabelText(/^question/i), "Will be cleared");
    await user.click(screen.getByTestId("change-anchor"));
    // Empty state restored, textareas gone.
    expect(screen.getByTestId("empty-state-no-anchor")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^question/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("anchored-passage")).not.toBeInTheDocument();
  });

  it("after Change, re-anchoring a passage clears the previously-typed question", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    await user.click(screen.getByText(/Article 3.1./));
    await user.type(screen.getByLabelText(/^question/i), "Old value");
    await user.click(screen.getByTestId("change-anchor"));
    // Re-anchor on a different passage from the list.
    await user.click(screen.getByText(/Article 3.2./));
    const q = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    expect(q.value).toBe("");
  });
});
