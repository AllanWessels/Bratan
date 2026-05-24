import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  useCorpusFiles: vi.fn(),
  useStartIngest: vi.fn(),
  useIngestStatus: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { CorpusBrowser } from "./CorpusBrowser";
import { useUIStore } from "@/store/uiStore";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
  mocks.useCorpusFiles.mockReturnValue({
    data: [
      {
        path: "intro.md",
        size_bytes: 2048,
        modified: "2026-05-01T00:00:00Z",
        ingested: true,
        n_chunks: 12,
      },
      {
        path: "guide.md",
        size_bytes: 5000,
        modified: "2026-05-01T00:00:00Z",
        ingested: false,
        n_chunks: null,
      },
    ],
    isLoading: false,
    isError: false,
  });
  mocks.useStartIngest.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  mocks.useIngestStatus.mockReturnValue({
    data: {
      state: "idle",
      task_id: null,
      files_total: 0,
      files_done: 0,
      chunks_written: 0,
      error: null,
      current_file: null,
      chunks_per_sec: null,
    },
    isLoading: false,
  });
});

describe("CorpusBrowser", () => {
  it("renders the list of corpus files", () => {
    render(withProviders(<CorpusBrowser />));
    expect(screen.getByText("intro.md")).toBeInTheDocument();
    expect(screen.getByText("guide.md")).toBeInTheDocument();
    expect(screen.getByText(/12 chunks/)).toBeInTheDocument();
    expect(screen.getByText(/not ingested/)).toBeInTheDocument();
  });

  it("renders an empty-state when no files are present", () => {
    mocks.useCorpusFiles.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    render(withProviders(<CorpusBrowser />));
    expect(screen.getByText(/No files in corpus/i)).toBeInTheDocument();
  });

  it("clicking 'Ingest corpus' triggers the start mutation", async () => {
    const startMutate = vi.fn();
    mocks.useStartIngest.mockReturnValue({
      mutate: startMutate,
      isPending: false,
    });
    const user = userEvent.setup();
    render(withProviders(<CorpusBrowser />));
    await user.click(screen.getByTestId("ingest-corpus"));
    expect(startMutate).toHaveBeenCalledTimes(1);
  });

  it("renders running state with progress bar, files_done count, and chunks/sec", () => {
    mocks.useIngestStatus.mockReturnValue({
      data: {
        state: "running",
        task_id: "t-1",
        files_total: 10,
        files_done: 3,
        chunks_written: 47,
        error: null,
        current_file: "docs/spec.md",
        chunks_per_sec: 8.5,
      },
      isLoading: false,
    });
    render(withProviders(<CorpusBrowser />));
    expect(screen.getByTestId("ingest-progress")).toBeInTheDocument();
    expect(screen.getByText(/3 \/ 10 files/)).toBeInTheDocument();
    expect(screen.getByText(/47 chunks/)).toBeInTheDocument();
    expect(screen.getByText(/8\.5\/s/)).toBeInTheDocument();
    expect(screen.getByTestId("ingest-current-file")).toHaveTextContent("docs/spec.md");
  });

  it("disables the ingest button while running", () => {
    mocks.useIngestStatus.mockReturnValue({
      data: {
        state: "running",
        task_id: "t-1",
        files_total: 10,
        files_done: 3,
        chunks_written: 47,
        error: null,
        current_file: null,
        chunks_per_sec: null,
      },
      isLoading: false,
    });
    render(withProviders(<CorpusBrowser />));
    expect(screen.getByTestId("ingest-corpus")).toBeDisabled();
  });

  it("pushes a success toast on the running→succeeded transition", async () => {
    const { rerender } = render(withProviders(<CorpusBrowser />));
    mocks.useIngestStatus.mockReturnValue({
      data: {
        state: "succeeded",
        task_id: "t-1",
        files_total: 10,
        files_done: 10,
        chunks_written: 200,
        error: null,
        current_file: null,
        chunks_per_sec: null,
      },
      isLoading: false,
    });
    rerender(withProviders(<CorpusBrowser />));
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      expect(toasts.some((t) => t.variant === "success")).toBe(true);
    });
  });

  it("pushes an error toast with the backend's error message on failure", async () => {
    const { rerender } = render(withProviders(<CorpusBrowser />));
    mocks.useIngestStatus.mockReturnValue({
      data: {
        state: "failed",
        task_id: "t-1",
        files_total: 10,
        files_done: 4,
        chunks_written: 22,
        error: "no such table: tenants",
        current_file: null,
        chunks_per_sec: null,
      },
      isLoading: false,
    });
    rerender(withProviders(<CorpusBrowser />));
    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      const err = toasts.find((t) => t.variant === "error");
      expect(err).toBeDefined();
      expect(err!.message).toContain("no such table: tenants");
    });
  });
});
