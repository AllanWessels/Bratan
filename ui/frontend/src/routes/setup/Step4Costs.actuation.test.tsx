import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step4Costs } from "./Step4Costs";

/**
 * Step4Costs is technically four `<input type="number">` controls, not
 * sliders (the agent task description was inaccurate on that point). This
 * test drives each input via fireEvent.change and asserts the autosave
 * payload reflects every value. fireEvent.change is preferred over
 * userEvent.type for number inputs because Step4Costs' onChange falls back
 * to 0/1 on empty strings, which can stutter when typing a multi-digit
 * value through userEvent.
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

describe("Step4Costs actuation — every cost ceiling input", () => {
  it("editing usd_per_run updates the visible value and the autosave payload", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/usd per run/i) as HTMLInputElement;
    fireEvent.change(f, { target: { value: "12.5" } });
    expect(f.value).toBe("12.5");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { usd_per_run: number } } }).data;
    expect(data.cost.usd_per_run).toBe(12.5);
  });

  it("editing tokens_per_iteration updates the autosave payload", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/tokens per iteration/i);
    fireEvent.change(f, { target: { value: "5000000" } });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { tokens_per_iteration: number } } })
      .data;
    expect(data.cost.tokens_per_iteration).toBe(5_000_000);
  });

  it("editing cache_ttl_hours updates the autosave payload", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/cache ttl/i);
    fireEvent.change(f, { target: { value: "72" } });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { cache_ttl_hours: number } } }).data;
    expect(data.cost.cache_ttl_hours).toBe(72);
  });

  it("editing subset_eval_size updates the autosave payload", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/subset eval size/i);
    fireEvent.change(f, { target: { value: "25" } });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { subset_eval_size: number } } }).data;
    expect(data.cost.subset_eval_size).toBe(25);
  });

  it("editing all four inputs in succession produces a coalesced final save", async () => {
    render(withProviders(<Step4Costs config={null} />));
    fireEvent.change(screen.getByLabelText(/usd per run/i), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText(/tokens per iteration/i), {
      target: { value: "3000000" },
    });
    fireEvent.change(screen.getByLabelText(/cache ttl/i), {
      target: { value: "48" },
    });
    fireEvent.change(screen.getByLabelText(/subset eval size/i), {
      target: { value: "15" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const cost = (save.body as {
      data: {
        cost: {
          usd_per_run: number;
          tokens_per_iteration: number;
          cache_ttl_hours: number;
          subset_eval_size: number;
        };
      };
    }).data.cost;
    expect(cost.usd_per_run).toBe(7);
    expect(cost.tokens_per_iteration).toBe(3_000_000);
    expect(cost.cache_ttl_hours).toBe(48);
    expect(cost.subset_eval_size).toBe(15);
  });

  it("an empty usd_per_run falls back to 0 (does not blow up the form)", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/usd per run/i) as HTMLInputElement;
    fireEvent.change(f, { target: { value: "" } });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { usd_per_run: number } } }).data;
    expect(data.cost.usd_per_run).toBe(0);
  });

  it("an empty subset_eval_size falls back to 1 (the floor)", async () => {
    render(withProviders(<Step4Costs config={null} />));
    const f = screen.getByLabelText(/subset eval size/i) as HTMLInputElement;
    fireEvent.change(f, { target: { value: "" } });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { cost: { subset_eval_size: number } } }).data;
    expect(data.cost.subset_eval_size).toBe(1);
  });
});
