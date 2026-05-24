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

  it("disables question + answer fields until a passage is anchored", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizardFromCorpus />));
    await user.click(screen.getByRole("button", { name: /fia-2026-regs\.md/ }));
    const question = screen.getByLabelText(/^question/i);
    const ground = screen.getByLabelText(/ground-truth answer/i);
    expect(question).toBeDisabled();
    expect(ground).toBeDisabled();
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
    // After save the question field is cleared, but the file rail still
    // marks the file as selected so the SME can author another case.
    expect(screen.getByLabelText(/^question/i)).toHaveValue("");
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
