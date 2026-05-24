import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastViewport } from "./Toast";
import { useUIStore } from "@/store/uiStore";

beforeEach(() => {
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  useUIStore.setState({ toasts: [] });
});

describe("ToastViewport", () => {
  it("renders nothing when there are no toasts", () => {
    render(<ToastViewport />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders a pushed toast with its message", () => {
    useUIStore.getState().pushToast("Hello world", "info");
    render(<ToastViewport />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders multiple toasts at once", () => {
    useUIStore.getState().pushToast("first", "info");
    useUIStore.getState().pushToast("second", "success");
    useUIStore.getState().pushToast("third", "error");
    render(<ToastViewport />);
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("third")).toBeInTheDocument();
  });

  it("applies the success styles", () => {
    useUIStore.getState().pushToast("done", "success");
    render(<ToastViewport />);
    const toast = screen.getByRole("status");
    expect(toast.className).toMatch(/emerald/);
  });

  it("applies the error styles", () => {
    useUIStore.getState().pushToast("uh oh", "error");
    render(<ToastViewport />);
    const toast = screen.getByRole("status");
    expect(toast.className).toMatch(/red/);
  });

  it("dismisses when the X button is clicked", async () => {
    useUIStore.getState().pushToast("close me", "info");
    const user = userEvent.setup();
    render(<ToastViewport />);
    await user.click(screen.getByLabelText(/dismiss notification/i));
    expect(screen.queryByText("close me")).not.toBeInTheDocument();
  });

  it("auto-dismisses after 4000ms", () => {
    vi.useFakeTimers();
    useUIStore.getState().pushToast("auto out", "info");
    render(<ToastViewport />);
    expect(screen.getByText("auto out")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(screen.queryByText("auto out")).not.toBeInTheDocument();
  });
});
