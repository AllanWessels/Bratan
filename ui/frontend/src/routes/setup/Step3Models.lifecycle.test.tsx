import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VLLMState, VLLMStatus } from "@/api/types";

/**
 * Audit row 12 — Step 3 vLLM lifecycle state transitions.
 *
 * Walks `useVLLMStatus` through stopped → starting → downloading → ready and
 * pins the consequences at each step:
 *
 *  - `stopped`: no `vllm-ready-hint`, Start button visible.
 *  - `starting`: state badge reads "starting", Stop button visible
 *    (component flips to Stop while `isRunning`), progress card visible.
 *  - `downloading`: progress indicator visible.
 *  - `ready`: the test mutation auto-fires exactly once, a success toast is
 *    pushed, `vllm-ready-hint` appears, Start button text flips to "Stop".
 *  - re-render `ready` → `ready`: the auto-fire effect stays one-shot;
 *    the test mutation is NOT called again.
 *
 * The Step 3 lifecycle is the most fragile multi-step effect in the app
 * (test-auto-fire + toast + ready hint + Start→Stop flip) and was
 * previously untested as a state machine — only the final terminal state
 * was rendered in isolation.
 */

const mocks = vi.hoisted(() => ({
  useVLLMStatus: vi.fn(),
  useStartVLLM: vi.fn(),
  useStopVLLM: vi.fn(),
  useTestVLLM: vi.fn(),
  useTestAnthropic: vi.fn(),
  // Pulled in transitively via useAutoSaveStep — Step 3 wires `useAutoSaveStep(3, data)`
  // which calls `useSaveStep()`. Without this entry the import resolves to undefined
  // and the render throws.
  useSaveStep: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { Step3Models } from "./Step3Models";
import { useUIStore } from "@/store/uiStore";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function statusReturn(state: VLLMState | null, overrides: Partial<VLLMStatus> = {}) {
  const data: VLLMStatus | undefined =
    state === null
      ? undefined
      : {
          state,
          model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
          port: 8001,
          base_url: "http://localhost:8001",
          elapsed_s: 0,
          message: null,
          ...overrides,
        };
  return { data, isPending: false, isError: false, isSuccess: data != null };
}

describe("Step3Models — vLLM lifecycle transitions", () => {
  let testMutate: ReturnType<typeof vi.fn>;
  let startMutate: ReturnType<typeof vi.fn>;
  let stopMutate: ReturnType<typeof vi.fn>;
  let pushToastSpy: ReturnType<typeof vi.fn>;
  const originalPushToast = useUIStore.getState().pushToast;

  beforeEach(() => {
    testMutate = vi.fn();
    startMutate = vi.fn();
    stopMutate = vi.fn();
    pushToastSpy = vi.fn();

    // Stub the toast queue so we can assert the success toast is pushed
    // without driving the UI store through its real setter.
    useUIStore.setState({ pushToast: pushToastSpy, toasts: [] });

    mocks.useVLLMStatus.mockReturnValue(statusReturn("stopped"));
    mocks.useStartVLLM.mockReturnValue({
      mutate: startMutate,
      isPending: false,
      error: null,
    });
    mocks.useStopVLLM.mockReturnValue({ mutate: stopMutate, isPending: false });
    mocks.useTestVLLM.mockReturnValue({
      mutate: testMutate,
      isPending: false,
      data: undefined,
    });
    mocks.useTestAnthropic.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      data: undefined,
    });
    // useAutoSaveStep(3, data) calls useSaveStep() — return a no-op mutate so
    // the autosave debounce can fire without exploding. We don't assert on it.
    mocks.useSaveStep.mockReturnValue({ mutate: vi.fn() });
  });

  afterEach(() => {
    // Restore the real pushToast so other suites in the same vitest worker
    // don't see a stub. (Zustand store state is module-level singleton.)
    useUIStore.setState({ pushToast: originalPushToast, toasts: [] });
    vi.clearAllMocks();
  });

  it("walks stopped → starting → downloading → ready and asserts each consequence", () => {
    const { rerender } = render(withProviders(<Step3Models config={null} />));

    // ---- stopped ----------------------------------------------------------
    expect(screen.queryByTestId("vllm-ready-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("vllm-start-button")).toBeInTheDocument();
    expect(screen.queryByTestId("vllm-stop-button")).not.toBeInTheDocument();
    expect(testMutate).not.toHaveBeenCalled();

    // ---- starting ---------------------------------------------------------
    mocks.useVLLMStatus.mockReturnValue(statusReturn("starting", { elapsed_s: 1.2 }));
    rerender(withProviders(<Step3Models config={null} />));

    const startingBadge = screen.getByTestId("vllm-state-badge");
    expect(startingBadge).toHaveAttribute("data-state", "starting");
    expect(startingBadge.textContent).toMatch(/starting/i);
    // isRunning → component flips the Start CTA to a Stop button.
    expect(screen.getByTestId("vllm-stop-button")).toBeInTheDocument();
    expect(screen.queryByTestId("vllm-start-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("vllm-progress")).toBeInTheDocument();
    expect(testMutate).not.toHaveBeenCalled();

    // ---- downloading ------------------------------------------------------
    mocks.useVLLMStatus.mockReturnValue(
      statusReturn("downloading", { elapsed_s: 4.7, message: "fetching shard 1/3" }),
    );
    rerender(withProviders(<Step3Models config={null} />));

    expect(screen.getByTestId("vllm-state-badge")).toHaveAttribute(
      "data-state",
      "downloading",
    );
    const progress = screen.getByTestId("vllm-progress");
    expect(progress.textContent).toMatch(/Downloading model weights/i);
    expect(progress.textContent).toMatch(/fetching shard 1\/3/);
    expect(testMutate).not.toHaveBeenCalled();

    // ---- ready (first transition) -----------------------------------------
    mocks.useVLLMStatus.mockReturnValue(statusReturn("ready", { elapsed_s: 8.1 }));
    rerender(withProviders(<Step3Models config={null} />));

    // Auto-fire: useTestVLLM.mutate called exactly once, with the live
    // base_url + prejudge_model from local component state (defaults).
    expect(testMutate).toHaveBeenCalledTimes(1);
    expect(testMutate).toHaveBeenCalledWith({
      base_url: "http://localhost:8001",
      model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
    });

    // Success toast pushed with the "vLLM is up" copy + success variant.
    expect(pushToastSpy).toHaveBeenCalledTimes(1);
    expect(pushToastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/vLLM is up/i),
      "success",
    );

    // The ready hint testid is now in the DOM.
    expect(screen.getByTestId("vllm-ready-hint")).toBeInTheDocument();
    // The Start CTA reads "Stop vLLM" because state===ready is isRunning.
    expect(screen.getByTestId("vllm-stop-button")).toBeInTheDocument();
    expect(screen.queryByTestId("vllm-start-button")).not.toBeInTheDocument();

    // ---- ready → ready (idempotent rerender) ------------------------------
    // The component uses a lastSeenStateRef gate to fire the auto-test
    // exactly once per stopped/starting/etc → ready transition. A second
    // rerender still in the ready state must NOT re-fire the test mutation
    // and must NOT push a second toast.
    rerender(withProviders(<Step3Models config={null} />));

    expect(testMutate).toHaveBeenCalledTimes(1);
    expect(pushToastSpy).toHaveBeenCalledTimes(1);
  });
});
