import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useUIStore } from "@/store/uiStore";

/**
 * Unit suite for ResetVectorStoreButton — the destructive
 * wipe-`.chroma/` action with a Type-RESET confirmation gate.
 *
 * The component is mounted in two places (Step 2 of the setup wizard and
 * the Run dashboard controls). This file covers the gate surface directly
 * so we are not relying on either parent's happy-path test to catch a
 * regression like "confirm is no longer exact-match" or "the trigger is
 * still clickable mid-ingest". Both would be loud user-visible breakages
 * but neither would fail the wizard's structural assertions.
 */

const mocks = vi.hoisted(() => ({
  useResetVectorStore: vi.fn(),
  useIngestStatus: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { ResetVectorStoreButton } from "./ResetVectorStoreButton";

type ResetReturn = {
  mutate: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
};

function makeResetReturn(overrides: Partial<ResetReturn> = {}): ResetReturn {
  return {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...overrides,
  };
}

function makeIngestStatus(state: "idle" | "running" | "succeeded" | "failed" = "idle") {
  return {
    data: {
      state,
      task_id: null,
      files_total: 0,
      files_done: 0,
      chunks_written: 0,
      error: null,
    },
    isLoading: false,
  };
}

beforeEach(() => {
  // Reset the real toast store so cross-test toast assertions don't bleed.
  useUIStore.setState({ toasts: [] });
  mocks.useResetVectorStore.mockReturnValue(makeResetReturn());
  mocks.useIngestStatus.mockReturnValue(makeIngestStatus("idle"));
});

afterEach(() => {
  useUIStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

describe("ResetVectorStoreButton", () => {
  it("renders the destructive trigger and no modal initially", () => {
    render(<ResetVectorStoreButton />);
    const trigger = screen.getByTestId("reset-vector-store-trigger");
    expect(trigger).toBeInTheDocument();
    // Danger variant maps to the red palette in Button.tsx.
    expect(trigger.className).toMatch(/bg-red-600/);
    // Modal is only mounted after the trigger is clicked.
    expect(
      screen.queryByTestId("reset-vector-store-modal"),
    ).not.toBeInTheDocument();
  });

  it("opens the confirm modal with input, Cancel, and a disabled Confirm", async () => {
    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));

    expect(screen.getByTestId("reset-vector-store-modal")).toBeInTheDocument();
    expect(
      screen.getByTestId("reset-vector-store-confirm-input"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();

    const confirm = screen.getByTestId("reset-vector-store-confirm");
    expect(confirm).toBeDisabled();
  });

  it("keeps Confirm disabled when the user types a non-matching string", async () => {
    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "WRONG",
    );

    expect(screen.getByTestId("reset-vector-store-confirm")).toBeDisabled();
  });

  it("enables Confirm once the user types RESET exactly", async () => {
    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "RESET",
    );

    expect(screen.getByTestId("reset-vector-store-confirm")).toBeEnabled();
  });

  it("invokes the reset mutation when Confirm is clicked", async () => {
    const mutate = vi.fn();
    mocks.useResetVectorStore.mockReturnValue(makeResetReturn({ mutate }));

    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "RESET",
    );
    await user.click(screen.getByTestId("reset-vector-store-confirm"));

    expect(mutate).toHaveBeenCalledTimes(1);
    // The component calls `reset.mutate(undefined, { onSuccess, onError })`.
    // The `{ confirm: true }` body lives inside the hook itself.
    const [variables, options] = mutate.mock.calls[0];
    expect(variables).toBeUndefined();
    expect(options).toEqual(
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("fires a success toast and closes the modal when the mutation succeeds", async () => {
    // Capture the options object and drive its onSuccess by hand — this is
    // the cleanest way to exercise the toast + close flow without spinning
    // up react-query for real.
    const mutate = vi.fn((...args: any[]): unknown => {
      const [, opts] = args as [
        unknown,
        { onSuccess: (res: unknown) => void },
      ];
      opts.onSuccess({
        ok: true,
        path_wiped: "/abs/.chroma",
        client_dropped: true,
      });
      return undefined;
    });
    mocks.useResetVectorStore.mockReturnValue(makeResetReturn({ mutate }));

    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "RESET",
    );
    await user.click(screen.getByTestId("reset-vector-store-confirm"));

    expect(
      screen.queryByTestId("reset-vector-store-modal"),
    ).not.toBeInTheDocument();
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("success");
    expect(toasts[0].message).toMatch(/wiped \/abs\/\.chroma/);
  });

  it("disables the trigger while an ingest is running", async () => {
    mocks.useIngestStatus.mockReturnValue(makeIngestStatus("running"));

    render(<ResetVectorStoreButton />);

    const trigger = screen.getByTestId("reset-vector-store-trigger");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringMatching(/disabled while ingest is running/i),
    );
  });

  it("surfaces an error message in the modal when the mutation errored", async () => {
    mocks.useResetVectorStore.mockReturnValue(
      makeResetReturn({
        isError: true,
        error: new Error("disk full"),
      }),
    );

    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));

    expect(screen.getByText("disk full")).toBeInTheDocument();
  });

  it("fires an error toast when the mutation rejects", async () => {
    const mutate = vi.fn((...args: any[]): unknown => {
      const [, opts] = args as [unknown, { onError: (err: Error) => void }];
      opts.onError(new Error("server unreachable"));
      return undefined;
    });
    mocks.useResetVectorStore.mockReturnValue(makeResetReturn({ mutate }));

    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.type(
      screen.getByTestId("reset-vector-store-confirm-input"),
      "RESET",
    );
    await user.click(screen.getByTestId("reset-vector-store-confirm"));

    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe("error");
    expect(toasts[0].message).toMatch(/server unreachable/);
    // Error path leaves the modal open so the user can retry / cancel.
    expect(screen.getByTestId("reset-vector-store-modal")).toBeInTheDocument();
  });

  it("dismisses via Cancel without invoking the mutation", async () => {
    const mutate = vi.fn();
    mocks.useResetVectorStore.mockReturnValue(makeResetReturn({ mutate }));

    const user = userEvent.setup();
    render(<ResetVectorStoreButton />);

    await user.click(screen.getByTestId("reset-vector-store-trigger"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(
      screen.queryByTestId("reset-vector-store-modal"),
    ).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });
});
