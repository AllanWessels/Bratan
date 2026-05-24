import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step7Stopping } from "./Step7Stopping";

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

beforeEach(() => {
  captured = [];
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function flushAutoSave() {
  await new Promise((r) => setTimeout(r, 700));
}

describe("Step7Stopping", () => {
  it("renders the five stop-criteria inputs with defaults", () => {
    render(withProviders(<Step7Stopping config={null} />));
    expect(screen.getByLabelText(/convergence threshold/i)).toHaveValue(0.02);
    expect(screen.getByLabelText(/convergence window/i)).toHaveValue(5);
    expect(screen.getByLabelText(/max iterations/i)).toHaveValue(50);
    expect(screen.getByLabelText(/anchor regression threshold/i)).toHaveValue(0.3);
    // regression_policy is two buttons, not a single input
    expect(
      screen.getByRole("button", { name: /warn \(continue\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /block \(stop loop\)/i }),
    ).toBeInTheDocument();
  });

  it("defaults to regression_policy=warn (warn button selected)", () => {
    render(withProviders(<Step7Stopping config={null} />));
    const warnBtn = screen.getByRole("button", { name: /warn \(continue\)/i });
    expect(warnBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking block flips regression_policy", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step7Stopping config={null} />));
    await user.click(screen.getByRole("button", { name: /block \(stop loop\)/i }));
    expect(
      screen.getByRole("button", { name: /block \(stop loop\)/i }),
    ).toHaveAttribute("aria-pressed", "true");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    expect(last.body).toHaveProperty("step", 7);
    const data = (last.body as { data: { stop: { regression_policy: string } } }).data;
    expect(data).toHaveProperty("stop");
    expect(data.stop.regression_policy).toBe("block");
  });

  it("auto-saves max_iterations edits wrapped as {stop: {...}}", async () => {
    render(withProviders(<Step7Stopping config={null} />));
    const max = screen.getByLabelText(/max iterations/i);
    // fireEvent.change because the input's onChange falls back to 1 on empty,
    // which interferes with userEvent.clear() + type().
    fireEvent.change(max, { target: { value: "100" } });
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { stop: { max_iterations: number } } }).data;
    expect(data.stop.max_iterations).toBe(100);
  });

  it("auto-saves convergence_threshold edits", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step7Stopping config={null} />));
    const thr = screen.getByLabelText(/convergence threshold/i);
    await user.clear(thr);
    await user.type(thr, "0.05");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { stop: { convergence_threshold: number } } }).data;
    expect(data.stop.convergence_threshold).toBe(0.05);
  });

  it("auto-saves anchor_regression_threshold edits", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step7Stopping config={null} />));
    const anchor = screen.getByLabelText(/anchor regression threshold/i);
    await user.clear(anchor);
    await user.type(anchor, "0.5");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { stop: { anchor_regression_threshold: number } } })
      .data;
    expect(data.stop.anchor_regression_threshold).toBe(0.5);
  });
});
