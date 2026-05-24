import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SeedDraft } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useSeedDrafts: vi.fn(),
  useDeleteDraft: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { DraftList } from "./DraftList";
import { useUIStore } from "@/store/uiStore";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const draftA: SeedDraft = {
  id: "draft-1",
  question: "What about thing X?",
  ground_truth: "",
  passages: [],
  failure_category: null,
  notes: "",
  created_at: "2026-05-23T10:00:00Z",
  updated_at: "2026-05-23T10:05:00Z",
};

const draftB: SeedDraft = {
  id: "draft-2",
  question: "",
  ground_truth: "",
  passages: [],
  failure_category: null,
  notes: "",
  created_at: "2026-05-23T10:00:00Z",
  updated_at: "2026-05-23T10:06:00Z",
};

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
  mocks.useSeedDrafts.mockReturnValue({ data: [], isLoading: false });
  mocks.useDeleteDraft.mockReturnValue({ mutate: vi.fn() });
});

describe("DraftList", () => {
  it("renders the empty-state when no drafts", () => {
    render(withProviders(<DraftList />));
    expect(screen.getByText(/No drafts yet/i)).toBeInTheDocument();
  });

  it("renders a Loading message when isLoading is true", () => {
    mocks.useSeedDrafts.mockReturnValue({ data: undefined, isLoading: true });
    render(withProviders(<DraftList />));
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("renders each draft's question", () => {
    mocks.useSeedDrafts.mockReturnValue({ data: [draftA, draftB], isLoading: false });
    render(withProviders(<DraftList />));
    expect(screen.getByText("What about thing X?")).toBeInTheDocument();
    expect(screen.getByText(/untitled/)).toBeInTheDocument();
  });

  it("clicking the discard button triggers the delete mutation with the draft id", async () => {
    const delMutate = vi.fn((_id, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    mocks.useDeleteDraft.mockReturnValue({ mutate: delMutate });
    mocks.useSeedDrafts.mockReturnValue({ data: [draftA], isLoading: false });
    const user = userEvent.setup();
    render(withProviders(<DraftList />));
    await user.click(screen.getByLabelText(/discard draft/i));
    expect(delMutate).toHaveBeenCalled();
    expect(delMutate.mock.calls[0][0]).toBe("draft-1");
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.message === "Draft discarded")).toBe(true);
    });
  });

  it("selecting a draft fires onSelect with the draft id", async () => {
    mocks.useSeedDrafts.mockReturnValue({ data: [draftA], isLoading: false });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(withProviders(<DraftList onSelect={onSelect} />));
    await user.click(screen.getByText("What about thing X?"));
    expect(onSelect).toHaveBeenCalledWith("draft-1");
  });
});
