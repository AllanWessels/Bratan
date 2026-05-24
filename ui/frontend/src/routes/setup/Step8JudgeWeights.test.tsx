import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step8JudgeWeights } from "./Step8JudgeWeights";

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

describe("Step8JudgeWeights", () => {
  it("renders three weight sliders with defaults 0.4 / 0.3 / 0.3", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getByLabelText(/^correctness$/i)).toHaveValue("0.4");
    expect(screen.getByLabelText(/recall @ 5/i)).toHaveValue("0.3");
    expect(screen.getByLabelText(/^faithfulness$/i)).toHaveValue("0.3");
  });

  it("shows the prominent red comparability banner", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/invalidates comparability/i);
    // Should be styled prominently with red.
    expect(alert.className).toMatch(/red/);
  });

  it("displays Sum: 1.00 (valid) with default weights", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getByText(/Sum:/)).toBeInTheDocument();
    expect(screen.getByText(/1\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\(valid\)/i)).toBeInTheDocument();
  });

  it("warns when weights don't sum to 1.0", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    const corr = screen.getByLabelText(/^correctness$/i);
    fireEvent.change(corr, { target: { value: "0.9" } });
    expect(screen.getByText(/weights should sum to 1\.00/i)).toBeInTheDocument();
  });

  it("auto-saves slider changes wrapped as {judge_weights: {...}}", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    const corr = screen.getByLabelText(/^correctness$/i);
    fireEvent.change(corr, { target: { value: "0.6" } });
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    expect(last.body).toHaveProperty("step", 8);
    const data = (last.body as { data: { judge_weights: { correctness: number } } }).data;
    expect(data).toHaveProperty("judge_weights");
    expect(data.judge_weights.correctness).toBeCloseTo(0.6, 5);
  });
});
