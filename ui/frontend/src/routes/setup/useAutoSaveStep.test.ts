/**
 * Regression test for the wizard-wrapping bug.
 *
 * The backend's save-step endpoint deep-merges its `data` payload into the
 * existing BratanConfig. Each step's slice must be wrapped with the right
 * top-level key (e.g. {project: {...}}, NOT {project_name: ...}) or Pydantic
 * silently drops the unknown top-level keys and the wizard input is lost.
 *
 * If this test fails, the wizard is broken — values the user enters won't
 * persist.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { useAutoSaveStep } from "./useAutoSaveStep";

const originalFetch = globalThis.fetch;
const captured: { body: Record<string, unknown> }[] = [];

function mockFetch() {
  globalThis.fetch = (async (_url, init) => {
    if (init?.body) {
      captured.push({ body: JSON.parse(init.body as string) });
    }
    return new Response(
      JSON.stringify({ ok: true, config: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  captured.length = 0;
  vi.restoreAllMocks();
});

async function flushAutoSave() {
  // 500ms autosave delay + a few extra ticks for the mutation to fire.
  await new Promise((r) => setTimeout(r, 700));
}

describe("useAutoSaveStep wrapping (regression for the silent-drop bug)", () => {
  it("step 1 wraps ProjectBasics as {project: ...}", async () => {
    mockFetch();
    const { rerender } = renderHook(
      ({ data }: { data: unknown }) => useAutoSaveStep(1, data),
      {
        wrapper,
        initialProps: { data: { project_name: "a", corpus_path: "./c", seed_target_n: 10 } },
      },
    );
    rerender({ data: { project_name: "b", corpus_path: "./c", seed_target_n: 10 } });
    await flushAutoSave();
    expect(captured.length).toBeGreaterThan(0);
    const body = captured.at(-1)!.body as { step: number; data: Record<string, unknown> };
    expect(body.step).toBe(1);
    expect(body.data).toHaveProperty("project");
    expect((body.data as { project: Record<string, unknown> }).project.project_name).toBe("b");
  });

  it("step 5 also wraps as {project: ...} (seed_target_n lives there)", async () => {
    mockFetch();
    const { rerender } = renderHook(
      ({ data }: { data: unknown }) => useAutoSaveStep(5, data),
      {
        wrapper,
        initialProps: { data: { project_name: "x", corpus_path: "./c", seed_target_n: 50 } },
      },
    );
    rerender({ data: { project_name: "x", corpus_path: "./c", seed_target_n: 10 } });
    await flushAutoSave();
    const body = captured.at(-1)!.body as { data: { project: { seed_target_n: number } } };
    expect(body.data.project.seed_target_n).toBe(10);
  });

  it.each([
    [2, "vector_db"],
    [3, "models"],
    [4, "cost"],
    [7, "stop"],
    [8, "judge_weights"],
  ])("step %i wraps as {%s: ...}", async (step, key) => {
    mockFetch();
    const { rerender } = renderHook(
      ({ data }: { data: unknown }) => useAutoSaveStep(step, data),
      { wrapper, initialProps: { data: { a: 1 } } },
    );
    rerender({ data: { a: 2 } });
    await flushAutoSave();
    const body = captured.at(-1)!.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty(key);
    expect((body.data as Record<string, Record<string, unknown>>)[key].a).toBe(2);
  });

  it("step 6 (GPU probe) does not auto-save", async () => {
    mockFetch();
    const { rerender } = renderHook(
      ({ data }: { data: unknown }) => useAutoSaveStep(6, data),
      { wrapper, initialProps: { data: { a: 1 } } },
    );
    rerender({ data: { a: 2 } });
    await flushAutoSave();
    expect(captured.length).toBe(0);
  });
});
