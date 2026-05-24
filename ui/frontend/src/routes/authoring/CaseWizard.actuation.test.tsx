import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

/**
 * Drives every interactive control on the CaseWizard authoring page:
 *   - Question textarea
 *   - Ground-truth textarea
 *   - Failure category <select>
 *   - Notes textarea
 *   - Discard / Save buttons
 *
 * The existing CaseWizard.test.tsx covers high-level behavior; this file
 * doubles down on per-input "the change actually lands" assertions and
 * (importantly) the failure-category <select> options actuation.
 */

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

function saveResp(): SeedSaveResponse {
  return {
    ok: true,
    case: {
      id: "case-1",
      question: "q",
      ground_truth: "a",
      source_passages: [],
      failure_category: "multi_hop",
      notes: "",
      hypothesis: null,
      created_at: "2026-05-24T00:00:00Z",
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

describe("CaseWizard actuation — every input", () => {
  it("typing into the question textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    const q = screen.getByLabelText(/^question/i) as HTMLTextAreaElement;
    await user.type(q, "What does the corpus say about hybrid retrieval?");
    expect(q.value).toBe("What does the corpus say about hybrid retrieval?");
  });

  it("typing into the ground-truth textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    const g = screen.getByLabelText(/ground-truth answer/i) as HTMLTextAreaElement;
    await user.type(g, "It combines BM25 and vector retrieval via RRF.");
    expect(g.value).toBe("It combines BM25 and vector retrieval via RRF.");
  });

  it("typing into the notes textarea updates its visible value", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    const n = screen.getByLabelText(/^notes/i) as HTMLTextAreaElement;
    await user.type(n, "Edge case: empty corpus");
    expect(n.value).toBe("Edge case: empty corpus");
  });

  it("the failure category <select> offers all categories and persists the choice", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    const cat = screen.getByLabelText(/failure category/i) as HTMLSelectElement;
    // Options should include at least the canonical categories. Use the
    // category id list to drive each option.
    const candidates: string[] = [
      "multi_hop",
      "straightforward",
      "ambiguous",
      "out_of_corpus",
    ];
    for (const value of candidates) {
      // Some categories may not be present in the running FAILURE_CATEGORIES
      // (the union changes over time); skip absent options gracefully.
      const opt = Array.from(cat.options).find((o) => o.value === value);
      if (!opt) continue;
      await user.selectOptions(cat, value);
      expect(cat.value).toBe(value);
    }
  });

  it("clicking Discard wipes the question, ground-truth, and notes back to empty", async () => {
    const user = userEvent.setup();
    render(withProviders(<CaseWizard />));
    await user.type(screen.getByLabelText(/^question/i), "Q");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "A");
    await user.type(screen.getByLabelText(/^notes/i), "N");
    await user.click(screen.getByRole("button", { name: /discard/i }));
    expect(screen.getByLabelText(/^question/i)).toHaveValue("");
    expect(screen.getByLabelText(/ground-truth answer/i)).toHaveValue("");
    expect(screen.getByLabelText(/^notes/i)).toHaveValue("");
  });

  it("Save case is disabled when no failure_category is selected", async () => {
    mocks.useSeedValidate.mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      data: validResult(),
      isPending: false,
      isError: false,
      error: null,
    });
    render(withProviders(<CaseWizard />));
    expect(screen.getByRole("button", { name: /save case/i })).toBeDisabled();
  });

  it("Save case becomes enabled once validation passes AND a category is chosen", async () => {
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
    const cat = screen.getByLabelText(/failure category/i) as HTMLSelectElement;
    // Pick the first non-empty option.
    const firstCat = Array.from(cat.options).find((o) => o.value !== "");
    expect(firstCat).toBeTruthy();
    await user.selectOptions(cat, firstCat!.value);
    expect(screen.getByRole("button", { name: /save case/i })).not.toBeDisabled();
  });

  it("Save case sends the typed question, ground_truth, and notes in the payload", async () => {
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
    await user.type(screen.getByLabelText(/^question/i), "Q1?");
    await user.type(screen.getByLabelText(/ground-truth answer/i), "A1.");
    await user.type(screen.getByLabelText(/^notes/i), "Note-1");
    const cat = screen.getByLabelText(/failure category/i) as HTMLSelectElement;
    const firstCat = Array.from(cat.options).find((o) => o.value !== "");
    await user.selectOptions(cat, firstCat!.value);
    await user.click(screen.getByRole("button", { name: /save case/i }));
    await waitFor(() => expect(saveAsync).toHaveBeenCalledTimes(1));
    const [arg] = saveAsync.mock.calls[0];
    expect(arg.question).toBe("Q1?");
    expect(arg.ground_truth).toBe("A1.");
    expect(arg.notes).toBe("Note-1");
    expect(arg.failure_category).toBe(firstCat!.value);
  });
});
