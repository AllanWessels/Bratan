import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step5SeedTarget } from "./Step5SeedTarget";
import { drag, sliderPct } from "@/test/actuation-helpers";

/**
 * Drives the single slider on Step5SeedTarget to multiple values and
 * asserts every change lands in the autosave payload, plus the fill
 * percentage reflects the value-to-range ratio.
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

describe("Step5SeedTarget actuation", () => {
  it("dragging to 100 lands in the save payload as project.seed_target_n", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    drag(screen.getByLabelText(/target number of seed cases/i), 100);
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { project: { seed_target_n: number } } }).data;
    expect(data.project.seed_target_n).toBe(100);
  });

  it("dragging respects the step (5) — values snap to multiples of 5", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    drag(screen.getByLabelText(/target number of seed cases/i), 80);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { project: { seed_target_n: number } } }
    ).data;
    expect(data.project.seed_target_n % 5).toBe(0);
  });

  it("dragging to max clamps to 200", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    drag(screen.getByLabelText(/target number of seed cases/i), 5000);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { project: { seed_target_n: number } } }
    ).data;
    expect(data.project.seed_target_n).toBe(200);
  });

  it("dragging to min clamps to 10", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    drag(screen.getByLabelText(/target number of seed cases/i), -5);
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { project: { seed_target_n: number } } }
    ).data;
    expect(data.project.seed_target_n).toBe(10);
  });

  it("the slider exposes a percentage that matches (value-min)/(max-min)", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    // Default value 50, range 10..200 → (50-10)/190 ≈ 21.05%
    expect(sliderPct(input)).toBeCloseTo(((50 - 10) / 190) * 100, 1);
  });

  it("the slider uses a deterministic data-testid", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    expect(
      screen.getByTestId("slider-target-number-of-seed-cases"),
    ).toBeInTheDocument();
  });
});
