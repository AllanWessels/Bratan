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

  // ---- Audit row 3: slider mis-mapping regression ----
  //
  // The class of bug: a refactor swaps which slider's onChange writes to
  // which field of `data`, so dragging "Correctness" silently mutates
  // `recall_at_5` (or vice versa). The actuation tests assert the dragged
  // slider's *own* field updates, but never that the OTHER two fields are
  // untouched in the same payload — that's the gap this test closes.

  it("dragging correctness writes ONLY correctness; recall_at_5 + faithfulness unchanged", async () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    // Defaults are 0.4 / 0.3 / 0.3. Drag correctness to 0.7 — the autosave
    // payload should reflect correctness=0.7 with the other two pinned.
    const corr = screen.getByLabelText(/^correctness$/i);
    fireEvent.change(corr, { target: { value: "0.7" } });
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const data = (saves.at(-1)!.body as {
      data: { judge_weights: { correctness: number; recall_at_5: number; faithfulness: number } };
    }).data;
    expect(data.judge_weights.correctness).toBeCloseTo(0.7, 5);
    // The two untouched fields should still hold their defaults — a mis-mapped
    // slider would have written 0.7 into one of these instead.
    expect(data.judge_weights.recall_at_5).toBeCloseTo(0.3, 5);
    expect(data.judge_weights.faithfulness).toBeCloseTo(0.3, 5);
  });

  // ---- Audit row 14: sum-gate design lock ----
  //
  // Currently the sum-to-1 check is a banner only — the wizard Next button
  // is NOT disabled, so a user can advance to /authoring with mis-summed
  // weights. This test locks the present design ("warn, don't block") into
  // a test instead of folklore: assert the warning banner appears when the
  // sum drifts off 1.0, and that nothing about the component disables a
  // hypothetical Next sibling. If the team decides to switch to hard
  // gating, FLIP this test.
  //
  // TODO: prod design decision — the SetupWizard's `wizard-next` button is
  // currently enabled even when weights sum != 1.0. Decide whether that's
  // intentional ("warn, don't block") or a bug. If the latter, the
  // SetupWizard should accept a `canAdvance` signal from Step8JudgeWeights
  // and disable Next; flip this test to assert `disabled`.

  it("with weights summing to 0.9 (≠ 1.0), the warning banner is visible (current design: warn, not block)", () => {
    render(withProviders(<Step8JudgeWeights config={null} />));
    // 0.3 + 0.3 + 0.3 = 0.9 — off by 0.1, well outside the 0.001 tolerance.
    fireEvent.change(screen.getByLabelText(/^correctness$/i), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText(/recall @ 5/i), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText(/^faithfulness$/i), { target: { value: "0.3" } });
    // Current design: a warning banner replaces the "(valid)" copy.
    expect(screen.getByText(/should sum to 1\.00/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(valid\)/i)).not.toBeInTheDocument();
    // The component itself exposes no hard-gate; document that. If a Next
    // button is later wired through `canAdvance`, flip the assertion.
    expect(screen.queryByTestId("wizard-next")).not.toBeInTheDocument();
  });
});
