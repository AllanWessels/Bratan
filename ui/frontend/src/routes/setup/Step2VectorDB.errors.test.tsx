import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Real-error path — audit row 4 (UI coverage 2026-05-24).
 *
 * Mocks `useTestVectorDB` to return a realistic chromadb failure
 * (`{ok:false, error:"the tenant 'corpus' does not exist"}`) and asserts
 * the verbatim error string lands in the DOM. Catches the class of bug
 * where the UI swallows the backend's actual error message in favor of a
 * generic "connection failed" — the same swallowed-error UX that
 * started this session.
 */

const mocks = vi.hoisted(() => ({
  useTestVectorDB: vi.fn(),
  useSaveStep: vi.fn(),
  useResetVectorStore: vi.fn(),
  useIngestStatus: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Step2VectorDB } from "./Step2VectorDB";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  mocks.useTestVectorDB.mockReturnValue({
    mutate: vi.fn(),
    data: {
      ok: false,
      error: "the tenant 'corpus' does not exist",
      latency_ms: null,
      detail: null,
    },
    isPending: false,
    isError: false,
  });
  mocks.useSaveStep.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  });
  mocks.useResetVectorStore.mockReturnValue({
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

describe("Step2VectorDB — Test connection surfaces verbatim backend errors", () => {
  it("renders the chromadb 'tenant does not exist' error string verbatim", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /test connection/i }));
    expect(screen.getByText(/tenant 'corpus' does not exist/)).toBeInTheDocument();
  });
});
