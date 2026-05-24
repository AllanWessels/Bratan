import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step3Models } from "./Step3Models";

/**
 * Drives every interactive element in Step3Models:
 *   - API key text input (+ show/hide eye toggle)
 *   - Anthropic Test button
 *   - vLLM base_url text input + Test button
 *   - Three local-model toggle switches
 *   - oracle_model, prejudge_model, embedding_model, reranker_model fields
 *
 * Existing Step3Models.test.tsx covers some of these in isolation; this file
 * adds the missing "every field receives input and propagates to the save
 * payload" coverage (oracle_model, prejudge_model, embedding_model,
 * reranker_model, the other two toggles, etc.).
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
    if (
      u.includes("/api/setup/test-anthropic") ||
      u.includes("/api/setup/test-vllm")
    ) {
      return new Response(
        JSON.stringify({ ok: true, error: null, latency_ms: 22, detail: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
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

describe("Step3Models actuation — every input", () => {
  it("typing an oracle_model lands in the save payload as models.oracle_model", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const oracle = screen.getByLabelText(/oracle model/i);
    await user.clear(oracle);
    await user.type(oracle, "claude-sonnet-4-7");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { models: { oracle_model: string } } }).data;
    expect(data.models.oracle_model).toBe("claude-sonnet-4-7");
  });

  it("typing a prejudge_model lands in the save payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const f = screen.getByLabelText(/pre-judge model/i);
    await user.clear(f);
    await user.type(f, "Qwen/Qwen2.5-14B-Instruct-AWQ");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { models: { prejudge_model: string } } }).data;
    expect(data.models.prejudge_model).toBe("Qwen/Qwen2.5-14B-Instruct-AWQ");
  });

  it("typing an embedding_model lands in the save payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const f = screen.getByLabelText(/embedding model/i);
    await user.clear(f);
    await user.type(f, "BAAI/bge-large-en-v1.5");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { models: { embedding_model: string } } }).data;
    expect(data.models.embedding_model).toBe("BAAI/bge-large-en-v1.5");
  });

  it("typing a reranker_model lands in the save payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const f = screen.getByLabelText(/reranker model/i);
    await user.clear(f);
    await user.type(f, "BAAI/bge-reranker-large");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { models: { reranker_model: string } } }).data;
    expect(data.models.reranker_model).toBe("BAAI/bge-reranker-large");
  });

  it("clicking every local-model toggle flips the corresponding boolean", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    // Defaults: all three on. Click each.
    const embed = screen.getByLabelText(/local embedding/i);
    const rerank = screen.getByLabelText(/local reranker/i);
    const prejudge = screen.getByLabelText(/local pre-judge/i);
    await user.click(embed);
    await user.click(rerank);
    await user.click(prejudge);
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: {
        models: {
          use_local_embedding: boolean;
          use_local_reranker: boolean;
          use_local_prejudge: boolean;
        };
      };
    }).data;
    expect(data.models.use_local_embedding).toBe(false);
    expect(data.models.use_local_reranker).toBe(false);
    expect(data.models.use_local_prejudge).toBe(false);
  });

  it("Anthropic Test POSTs the API key + oracle model to /test-anthropic", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    await user.type(screen.getByLabelText(/^api key/i), "sk-ant-test-123");
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    await user.click(testButtons[0]); // Anthropic
    await waitFor(() => {
      expect(
        captured.filter((c) => c.url.includes("/api/setup/test-anthropic")).length,
      ).toBeGreaterThanOrEqual(1);
    });
    const call = captured.find((c) => c.url.includes("/api/setup/test-anthropic"))!;
    expect((call.body as { api_key: string }).api_key).toBe("sk-ant-test-123");
    expect((call.body as { model: string }).model).toBe("claude-sonnet-4-6");
  });

  it("vLLM Test POSTs the base URL + prejudge model to /test-vllm", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    // Open the URL field and edit it before clicking Test.
    const url = screen.getByLabelText(/base url/i);
    await user.clear(url);
    await user.type(url, "http://10.0.0.7:8002");
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    await user.click(testButtons[1]); // vLLM
    await waitFor(() => {
      expect(
        captured.filter((c) => c.url.includes("/api/setup/test-vllm")).length,
      ).toBeGreaterThanOrEqual(1);
    });
    const call = captured.find((c) => c.url.includes("/api/setup/test-vllm"))!;
    expect((call.body as { base_url: string }).base_url).toBe("http://10.0.0.7:8002");
  });

  it("show/hide eye toggle alternates the API key field type on each click", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const key = screen.getByLabelText(/^api key/i);
    expect(key).toHaveAttribute("type", "password");
    await user.click(screen.getByLabelText(/show api key/i));
    expect(key).toHaveAttribute("type", "text");
    await user.click(screen.getByLabelText(/hide api key/i));
    expect(key).toHaveAttribute("type", "password");
  });

  it("typing an Anthropic API key lands in the save payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    await user.type(screen.getByLabelText(/^api key/i), "sk-ant-typed");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { models: { anthropic_api_key: string } } }).data;
    expect(data.models.anthropic_api_key).toBe("sk-ant-typed");
  });
});
