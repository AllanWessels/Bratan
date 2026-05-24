import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step7Stopping } from "./Step7Stopping";

/**
 * Drives every input on Step7Stopping:
 *   - convergence_threshold (number)
 *   - convergence_window (number)
 *   - max_iterations (number)
 *   - anchor_regression_threshold (number)
 *   - regression_policy (radio pair: warn | block)
 *
 * Existing Step7Stopping.test.tsx covers max_iterations and the policy
 * toggle, but the other three numeric fields had no actuation coverage.
 */

const originalFetch = globalThis.fetch;
let captured: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function mockFetch() {
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = null;
      }
    }
    captured.push({ url: u, body });
    return new Response(JSON.stringify({ ok: true, config: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

async function flushAutoSave() {
  await new Promise((r) => setTimeout(r, 700));
}

beforeEach(() => {
  captured = [];
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Step7Stopping actuation — every threshold", () => {
  it("editing convergence_window updates the autosave payload", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    fireEvent.change(screen.getByLabelText(/convergence window/i), {
      target: { value: "8" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { stop: { convergence_window: number } } }).data;
    expect(data.stop.convergence_window).toBe(8);
  });

  it("editing convergence_threshold to 0.03 updates the autosave payload", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    fireEvent.change(screen.getByLabelText(/convergence threshold/i), {
      target: { value: "0.03" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { stop: { convergence_threshold: number } } })
      .data;
    expect(data.stop.convergence_threshold).toBe(0.03);
  });

  it("editing max_iterations updates the autosave payload", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    fireEvent.change(screen.getByLabelText(/max iterations/i), {
      target: { value: "200" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { stop: { max_iterations: number } } }).data;
    expect(data.stop.max_iterations).toBe(200);
  });

  it("editing anchor_regression_threshold updates the autosave payload", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    fireEvent.change(screen.getByLabelText(/anchor regression threshold/i), {
      target: { value: "0.45" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: { stop: { anchor_regression_threshold: number } };
    }).data;
    expect(data.stop.anchor_regression_threshold).toBe(0.45);
  });

  it("clicking warn ↔ block flips regression_policy and updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step7Stopping config={null} />));
    await user.click(screen.getByRole("button", { name: /block \(stop loop\)/i }));
    await flushAutoSave();
    let last = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    let data = (last.body as { data: { stop: { regression_policy: string } } }).data;
    expect(data.stop.regression_policy).toBe("block");
    // Flip back.
    await user.click(screen.getByRole("button", { name: /warn \(continue\)/i }));
    await flushAutoSave();
    last = captured.filter((c) => c.url.includes("/api/setup/save-step")).at(-1)!;
    data = (last.body as { data: { stop: { regression_policy: string } } }).data;
    expect(data.stop.regression_policy).toBe("warn");
  });

  it("editing every field in turn produces a final save with every value", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    fireEvent.change(screen.getByLabelText(/convergence threshold/i), {
      target: { value: "0.01" },
    });
    fireEvent.change(screen.getByLabelText(/convergence window/i), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/max iterations/i), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText(/anchor regression threshold/i), {
      target: { value: "0.2" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const stop = (save.body as {
      data: {
        stop: {
          convergence_threshold: number;
          convergence_window: number;
          max_iterations: number;
          anchor_regression_threshold: number;
        };
      };
    }).data.stop;
    expect(stop.convergence_threshold).toBe(0.01);
    expect(stop.convergence_window).toBe(3);
    expect(stop.max_iterations).toBe(25);
    expect(stop.anchor_regression_threshold).toBe(0.2);
  });
});
