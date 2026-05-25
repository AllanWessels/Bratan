import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SeedSaveResponse, SeedValidateResponse } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useSaveDraft: vi.fn(),
  useSeedSave: vi.fn(),
  useSeedValidate: vi.fn(),
  useCorpusSearch: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { CaseWizard } from "./CaseWizard";
import { useUIStore } from "@/store/uiStore";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
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

// Stuff one search hit into useCorpusSearch.data so PassagePicker renders an
// "Add passage to case" button. Tests then user.click that to populate
// draft.passages — required by the post-5ba5d55 canSave gate, which now
// correctly requires ≥1 passage (rather than gating on validate.data
// indirectly, which fabrication-mocked tests could bypass).
function seedSearchHit() {
  mocks.useCorpusSearch.mockReturnValue({
    mutate: vi.fn(),
    data: {
      passages: [
        {
          path: "doc.md",
          line_start: 1,
          line_end: 5,
          content: "Some passage content used by Save-case tests.",
          score: 0.9,
        },
      ],
      embedding_model: "stub",
      latency_ms: 42,
    },
    isPending: false,
    isError: false,
    error: null,
  });
}

async function addOnePassage(user: ReturnType<typeof userEvent.setup>) {
  // PassagePicker debounces its query 350ms before rendering hits.
  await waitFor(
    () =>
      expect(screen.getByLabelText(/add passage to case/i)).toBeInTheDocument(),
    { timeout: 1500 },
  );
  await user.click(screen.getByLabelText(/add passage to case/i));
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
      created_at: "2026-05-23T10:00:00Z",
      created_by: "human",
    },
    total_cases: 1,
    target_n: 50,
  };
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
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
  mocks.useCorpusSearch.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
    error: null,
  });
});

describe("CaseWizard", () => {
  it("renders the question, ground-truth, failure-category, and notes fields", () => {
    render(withProviders(<CaseWizard />));
    expect(screen.getByLabelText(/^question/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ground-truth answer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/failure category/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^notes/i)).toBeInTheDocument();
  });

  it("autofocuses the question textarea", () => {
    render(withProviders(<CaseWizard />));
    const question = screen.getByLabelText(/^question/i);
    expect(question).toBe(document.activeElement);
  });

  it("Save case is disabled until validation passes and a category is selected", () => {
    render(withProviders(<CaseWizard />));
    expect(screen.getByRole("button", { name: /save case/i })).toBeDisabled();
  });

  it("Save case is enabled with question + answer + passage + category", async () => {
    // Post-5ba5d55: canSave gates ONLY on required-field presence (no
    // validation pass-through). Drive the full required-field set.
    seedSearchHit();
    mocks.useSeedValidate.mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      data: validResult(),
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "What is X?");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "X is Y.");
    await addOnePassage(user);
    await user.selectOptions(
      screen.getByLabelText(/failure category/i),
      "straightforward",
    );
    expect(screen.getByRole("button", { name: /save case/i })).not.toBeDisabled();
  });

  it("clicking Save calls seedSave.mutateAsync with the wrapped payload", async () => {
    seedSearchHit();
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
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "What is X?");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "X is Y.");
    await addOnePassage(user);
    await user.selectOptions(
      screen.getByLabelText(/failure category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      expect(saveAsync).toHaveBeenCalledTimes(1);
    });
    const [arg] = saveAsync.mock.calls[0];
    expect(arg).toMatchObject({
      question: "What is X?",
      ground_truth: "X is Y.",
      failure_category: "straightforward",
    });
    expect(arg).toHaveProperty("draft_id");
  });

  it("pushes a success toast and resets the wizard after save", async () => {
    seedSearchHit();
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
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "What is X?");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "X is Y.");
    await addOnePassage(user);
    await user.selectOptions(
      screen.getByLabelText(/failure category/i),
      "straightforward",
    );
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.variant === "success" && t.message.includes("1 / 50"))).toBe(
        true,
      );
    });
    expect(screen.getByLabelText(/^question/i)).toHaveValue("");
  });

  it("pushes an error toast on save failure (e.g. 409 duplicate)", async () => {
    seedSearchHit();
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
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "Dup question");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "X is Y.");
    await addOnePassage(user);
    await user.selectOptions(
      screen.getByLabelText(/failure category/i),
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

  it("Discard resets the wizard", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "Some question");
    expect(screen.getByLabelText(/^question/i)).toHaveValue("Some question");
    await user.click(screen.getByRole("button", { name: /discard/i }));
    expect(screen.getByLabelText(/^question/i)).toHaveValue("");
  });

  it("auto-saves drafts on a 2s interval", async () => {
    vi.useFakeTimers();
    const draftMutate = vi.fn();
    mocks.useSaveDraft.mockReturnValue({ mutate: draftMutate, mutateAsync: vi.fn() });
    render(withProviders(<CaseWizard />));
    // Type with userEvent? With fake timers we need to use fireEvent or set directly.
    // Use fireEvent.change via testing-library so the state updates synchronously.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText(/^question/i), {
      target: { value: "what about thing" },
    });
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    expect(draftMutate).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
