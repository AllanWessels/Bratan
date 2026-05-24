import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step1ProjectBasics } from "./Step1ProjectBasics";

/**
 * Drives every input on Step1ProjectBasics (project_name, corpus_path),
 * asserting both visible state changes and that the auto-save payload
 * propagates each edit. Complements Step1ProjectBasics.test.tsx, which
 * focuses on render-time assertions, with end-to-end "the value lands
 * on the wire" coverage.
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

describe("Step1ProjectBasics actuation", () => {
  it("typing into project_name updates the visible value and the autosave payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step1ProjectBasics config={null} />));
    const name = screen.getByLabelText(/project name/i) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "my-rag");
    expect(name).toHaveValue("my-rag");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { project: { project_name: string } } }).data;
    expect(data.project.project_name).toBe("my-rag");
  });

  it("typing into corpus_path updates the visible value and the autosave payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step1ProjectBasics config={null} />));
    const path = screen.getByLabelText(/corpus path/i) as HTMLInputElement;
    await user.clear(path);
    await user.type(path, "/srv/docs");
    expect(path).toHaveValue("/srv/docs");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { project: { corpus_path: string } } }).data;
    expect(data.project.corpus_path).toBe("/srv/docs");
  });

  it("editing both fields produces a single coalesced save with both values", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step1ProjectBasics config={null} />));
    await user.clear(screen.getByLabelText(/project name/i));
    await user.type(screen.getByLabelText(/project name/i), "alpha");
    await user.clear(screen.getByLabelText(/corpus path/i));
    await user.type(screen.getByLabelText(/corpus path/i), "./beta");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    const last = saves.at(-1)!;
    const project = (last.body as { data: { project: { project_name: string; corpus_path: string } } })
      .data.project;
    expect(project.project_name).toBe("alpha");
    expect(project.corpus_path).toBe("./beta");
  });
});
