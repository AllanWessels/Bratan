import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step8JudgeWeights } from "./Step8JudgeWeights";
import { drag, sliderPct } from "@/test/actuation-helpers";

/**
 * Drives all three weight sliders. Each test sets a value and confirms
 * both (a) the autosave payload receives the new weight and (b) the
 * sum-to-1 validation banner flips when the weights no longer sum to 1.
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

describe("Step8JudgeWeights actuation — three weights + sum validation", () => {
  it("dragging correctness updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    drag(screen.getByLabelText(/^correctness$/i), 0.7);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { correctness: number } } }
    ).data;
    expect(data.judge_weights.correctness).toBeCloseTo(0.7, 5);
  });

  it("dragging recall_at_5 updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    drag(screen.getByLabelText(/recall @ 5/i), 0.5);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { recall_at_5: number } } }
    ).data;
    expect(data.judge_weights.recall_at_5).toBeCloseTo(0.5, 5);
  });

  it("dragging faithfulness updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    drag(screen.getByLabelText(/^faithfulness$/i), 0.6);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { faithfulness: number } } }
    ).data;
    expect(data.judge_weights.faithfulness).toBeCloseTo(0.6, 5);
  });

  it("changing any single weight away from the default invalidates the sum-to-1 banner", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getByText(/\(valid\)/i)).toBeInTheDocument();
    drag(screen.getByLabelText(/^correctness$/i), 0.9);
    expect(screen.getByText(/should sum to 1\.00/i)).toBeInTheDocument();
  });

  it("setting weights back to a 1.00 sum re-validates the banner", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    drag(screen.getByLabelText(/^correctness$/i), 0.5);
    drag(screen.getByLabelText(/recall @ 5/i), 0.25);
    drag(screen.getByLabelText(/^faithfulness$/i), 0.25);
    expect(screen.getByText(/\(valid\)/i)).toBeInTheDocument();
  });

  it("each slider has a deterministic data-testid based on its label", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getByTestId("slider-correctness")).toBeInTheDocument();
    expect(screen.getByTestId("slider-recall-5")).toBeInTheDocument();
    expect(screen.getByTestId("slider-faithfulness")).toBeInTheDocument();
  });

  it("each slider reflects its value as a percentage on data-percentage", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    // Defaults: 0.4, 0.3, 0.3 over the 0..1 range.
    expect(sliderPct(screen.getByTestId("slider-correctness"))).toBeCloseTo(40, 1);
    expect(sliderPct(screen.getByTestId("slider-recall-5"))).toBeCloseTo(30, 1);
    expect(sliderPct(screen.getByTestId("slider-faithfulness"))).toBeCloseTo(30, 1);
  });
});
