import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

/**
 * Drives the single interactive control on CorpusBrowser (the
 * "Ingest corpus" button) through repeated clicks and asserts the
 * mutation fires once per click. Also verifies the button stays
 * disabled while a run is in flight.
 */

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
  mocks.useCorpusFiles.mockReturnValue({ data: [], isLoading: false, isError: false });
  mocks.useStartIngest.mockReturnValue({ mutate: vi.fn(), isPending: false });
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

describe("CorpusBrowser actuation — Ingest corpus button", () => {
  it("clicking Ingest corpus once fires startIngest.mutate once", async () => {
    const startMutate = vi.fn();
    mocks.useStartIngest.mockReturnValue({ mutate: startMutate, isPending: false });
    const user = userEvent.setup();
    render(withProviders(<CorpusBrowser />));
    await user.click(screen.getByTestId("ingest-corpus"));
    expect(startMutate).toHaveBeenCalledTimes(1);
  });

  it("clicking Ingest corpus multiple times when idle fires the mutation N times", async () => {
    const startMutate = vi.fn();
    mocks.useStartIngest.mockReturnValue({ mutate: startMutate, isPending: false });
    const user = userEvent.setup();
    render(withProviders(<CorpusBrowser />));
    const btn = screen.getByTestId("ingest-corpus");
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(startMutate).toHaveBeenCalledTimes(3);
  });

  it("Ingest button is disabled while running (does not fire mutation on click)", async () => {
    const startMutate = vi.fn();
    mocks.useStartIngest.mockReturnValue({ mutate: startMutate, isPending: false });
    mocks.useIngestStatus.mockReturnValue({
      data: {
        state: "running",
        task_id: "t",
        files_total: 5,
        files_done: 1,
        chunks_written: 10,
        error: null,
        current_file: null,
        chunks_per_sec: null,
      },
      isLoading: false,
    });
    const user = userEvent.setup();
    render(withProviders(<CorpusBrowser />));
    const btn = screen.getByTestId("ingest-corpus");
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(startMutate).not.toHaveBeenCalled();
  });
});
