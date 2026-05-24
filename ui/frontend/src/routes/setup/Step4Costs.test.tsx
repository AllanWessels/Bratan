import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step4Costs } from "./Step4Costs";

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

describe("Step4Costs", () => {
  it("renders all four numeric inputs with defaults", () => {
    render(withProviders(<Step4Costs config={null} />));
    expect(screen.getByLabelText(/usd per run/i)).toHaveValue(5);
    expect(screen.getByLabelText(/tokens per iteration/i)).toHaveValue(2_000_000);
    expect(screen.getByLabelText(/cache ttl/i)).toHaveValue(168);
    expect(screen.getByLabelText(/subset eval size/i)).toHaveValue(10);
  });

  it("renders the USD hint formatted as currency", () => {
    render(withProviders(<Step4Costs config={null} />));
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });

  it("renders the tokens hint formatted as k/M", () => {
    render(withProviders(<Step4Costs config={null} />));
    expect(screen.getByText(/2\.0M/)).toBeInTheDocument();
  });

  it("auto-saves usd_per_run wrapped as {cost: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step4Costs config={null} />));
    const usd = screen.getByLabelText(/usd per run/i);
    await user.clear(usd);
    await user.type(usd, "12.50");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    expect(last.body).toHaveProperty("step", 4);
    const data = (last.body as { data: { cost: { usd_per_run: number } } }).data;
    expect(data).toHaveProperty("cost");
    expect(data.cost.usd_per_run).toBe(12.5);
  });

  it("auto-saves tokens_per_iteration wrapped as {cost: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step4Costs config={null} />));
    const tok = screen.getByLabelText(/tokens per iteration/i);
    await user.clear(tok);
    await user.type(tok, "500000");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { cost: { tokens_per_iteration: number } } }).data;
    expect(data.cost.tokens_per_iteration).toBe(500000);
  });

  it("auto-saves cache_ttl_hours wrapped as {cost: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step4Costs config={null} />));
    const ttl = screen.getByLabelText(/cache ttl/i);
    await user.clear(ttl);
    await user.type(ttl, "24");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { cost: { cache_ttl_hours: number } } }).data;
    expect(data.cost.cache_ttl_hours).toBe(24);
  });

  it("auto-saves subset_eval_size wrapped as {cost: {...}}", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const subset = screen.getByLabelText(/subset eval size/i);
    // Use fireEvent.change so we set the controlled value atomically; user.clear()
    // would race against the min-1 fallback in the onChange handler.
    fireEvent.change(subset, { target: { value: "20" } });
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const data = (last.body as { data: { cost: { subset_eval_size: number } } }).data;
    expect(data.cost.subset_eval_size).toBe(20);
  });
});
