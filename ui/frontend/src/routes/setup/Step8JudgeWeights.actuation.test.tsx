import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step8JudgeWeights } from "./Step8JudgeWeights";

/**
 * Drives all three weight number inputs. Each test sets a value and
 * confirms both (a) the autosave payload receives the new weight and
 * (b) the sum-to-1 validation banner flips when the weights no longer
 * sum to 1.
 *
 * (Was previously slider-driven; the <Slider> was replaced with
 * <NumberInput> because the native range input's fill direction
 * misbehaved relative to the actual value.)
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
  it("editing correctness updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    fireEvent.change(screen.getByLabelText(/^correctness$/i), {
      target: { value: "0.7" },
    });
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { correctness: number } } }
    ).data;
    expect(data.judge_weights.correctness).toBeCloseTo(0.7, 5);
  });

  it("editing recall_at_5 updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    fireEvent.change(screen.getByLabelText(/recall @ 5/i), {
      target: { value: "0.5" },
    });
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { recall_at_5: number } } }
    ).data;
    expect(data.judge_weights.recall_at_5).toBeCloseTo(0.5, 5);
  });

  it("editing faithfulness updates the autosave payload", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    fireEvent.change(screen.getByLabelText(/^faithfulness$/i), {
      target: { value: "0.6" },
    });
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { judge_weights: { faithfulness: number } } }
    ).data;
    expect(data.judge_weights.faithfulness).toBeCloseTo(0.6, 5);
  });

  it("changing any single weight away from the default invalidates the sum-to-1 banner", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getAllByText(/\(valid\)/i).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/^correctness$/i), {
      target: { value: "0.9" },
    });
    expect(
      screen.getAllByText(/should sum to 1\.00/i).length,
    ).toBeGreaterThan(0);
  });

  it("setting weights back to a 1.00 sum re-validates the banner", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    fireEvent.change(screen.getByLabelText(/^correctness$/i), {
      target: { value: "0.5" },
    });
    fireEvent.change(screen.getByLabelText(/recall @ 5/i), {
      target: { value: "0.25" },
    });
    fireEvent.change(screen.getByLabelText(/^faithfulness$/i), {
      target: { value: "0.25" },
    });
    expect(screen.getAllByText(/\(valid\)/i).length).toBeGreaterThan(0);
  });

  it("each input has a deterministic data-testid based on its label", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(screen.getByTestId("number-input-correctness")).toBeInTheDocument();
    expect(screen.getByTestId("number-input-recall-5")).toBeInTheDocument();
    expect(screen.getByTestId("number-input-faithfulness")).toBeInTheDocument();
  });

  it("each input displays the 'weight' unit suffix", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    expect(
      screen.getByTestId("number-input-correctness-unit"),
    ).toHaveTextContent("weight");
    expect(
      screen.getByTestId("number-input-recall-5-unit"),
    ).toHaveTextContent("weight");
    expect(
      screen.getByTestId("number-input-faithfulness-unit"),
    ).toHaveTextContent("weight");
  });

  it("an out-of-range value (e.g. 1.5) lights up the red border + Min/Max hint without blocking the keystroke", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    fireEvent.change(screen.getByLabelText(/^correctness$/i), {
      target: { value: "1.5" },
    });
    expect(screen.getAllByText(/Min 0, Max 1/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/^correctness$/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});
