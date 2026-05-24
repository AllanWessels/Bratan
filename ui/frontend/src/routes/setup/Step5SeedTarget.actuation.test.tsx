import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step5SeedTarget } from "./Step5SeedTarget";

/**
 * Drives the number input on Step5SeedTarget to multiple values and
 * asserts every change lands in the autosave payload. Was previously a
 * slider-driven test; the <Slider> was replaced with <NumberInput>
 * because the range input's fill direction misbehaved.
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
  it("typing 100 lands in the save payload as project.seed_target_n", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    fireEvent.change(screen.getByLabelText(/target number of seed cases/i), {
      target: { value: "100" },
    });
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { project: { seed_target_n: number } } }).data;
    expect(data.project.seed_target_n).toBe(100);
  });

  it("typing an out-of-range high value still updates the payload but flags an error", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    fireEvent.change(screen.getByLabelText(/target number of seed cases/i), {
      target: { value: "5000" },
    });
    // The user sees an "out of range" hint, but the parent still gets the value
    // so it's not silently dropped — the parent can clamp at submit time.
    expect(
      screen.getByLabelText(/target number of seed cases/i),
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Min 10, Max 200/i)).toBeInTheDocument();
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { project: { seed_target_n: number } } }).data;
    expect(data.project.seed_target_n).toBe(5000);
  });

  it("typing an out-of-range low value flags the error", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    fireEvent.change(screen.getByLabelText(/target number of seed cases/i), {
      target: { value: "5" },
    });
    expect(screen.getByText(/Min 10, Max 200/i)).toBeInTheDocument();
  });

  it("typing 30 lands in the save payload (boundary of recommended range)", async () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    fireEvent.change(screen.getByLabelText(/target number of seed cases/i), {
      target: { value: "30" },
    });
    await flushAutoSave();
    const data = (
      captured
        .filter((c) => c.url.includes("/api/setup/save-step"))
        .at(-1)!.body as { data: { project: { seed_target_n: number } } }
    ).data;
    expect(data.project.seed_target_n).toBe(30);
  });

  it("the input exposes a deterministic data-testid", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    expect(
      screen.getByTestId("number-input-target-number-of-seed-cases"),
    ).toBeInTheDocument();
  });

  it("the input exposes aria-valuemin / aria-valuemax / aria-valuenow", () => {
    render(withProviders(<Step5SeedTarget config={null} />));
    const input = screen.getByLabelText(/target number of seed cases/i);
    expect(input).toHaveAttribute("aria-valuemin", "10");
    expect(input).toHaveAttribute("aria-valuemax", "200");
    expect(input).toHaveAttribute("aria-valuenow", "50");
  });
});
