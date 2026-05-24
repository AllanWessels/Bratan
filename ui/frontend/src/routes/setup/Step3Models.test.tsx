import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step3Models } from "./Step3Models";

const originalFetch = globalThis.fetch;
let captured: Array<{ url: string; body: Record<string, unknown> | null }> = [];

interface TestResponse {
  ok: boolean;
  error: string | null;
  latency_ms: number | null;
  detail: Record<string, unknown> | null;
}

const responses: Record<string, TestResponse> = {};

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
    for (const key of Object.keys(responses)) {
      if (u.includes(key)) {
        return new Response(JSON.stringify(responses[key]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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

beforeEach(() => {
  captured = [];
  Object.keys(responses).forEach((k) => delete responses[k]);
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function flushAutoSave() {
  await new Promise((r) => setTimeout(r, 700));
}

describe("Step3Models", () => {
  it("renders the Anthropic API key field (password type by default)", () => {
    render(withProviders(<Step3Models config={null} />));
    const keyInput = screen.getByLabelText(/^api key\*?$/i);
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("show/hide toggle reveals the API key value", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const keyInput = screen.getByLabelText(/^api key\*?$/i);
    expect(keyInput).toHaveAttribute("type", "password");
    await user.click(screen.getByLabelText(/show api key/i));
    expect(keyInput).toHaveAttribute("type", "text");
    await user.click(screen.getByLabelText(/hide api key/i));
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("Test button on the API key calls /api/setup/test-anthropic", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const keyInput = screen.getByLabelText(/^api key\*?$/i);
    await user.type(keyInput, "sk-ant-mykey");
    // The Anthropic card has a Test button. The Step3Models has two Test buttons
    // (anthropic + vllm). The first one is the Anthropic one.
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    await user.click(testButtons[0]);
    await waitFor(() => {
      const calls = captured.filter((c) => c.url.includes("/api/setup/test-anthropic"));
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    const call = captured.find((c) => c.url.includes("/api/setup/test-anthropic"))!;
    expect((call.body as { api_key: string }).api_key).toBe("sk-ant-mykey");
  });

  it("renders a friendly 401 message instead of raw JSON for invalid Anthropic keys", async () => {
    responses["/api/setup/test-anthropic"] = {
      ok: false,
      error: "authentication_error: invalid x-api-key",
      latency_ms: 120,
      detail: null,
    };
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    await user.type(screen.getByLabelText(/^api key\*?$/i), "sk-ant-bad");
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    await user.click(testButtons[0]);
    await waitFor(() => {
      expect(screen.getByTestId("anthropic-error-message")).toBeInTheDocument();
    });
    const msg = screen.getByTestId("anthropic-error-message");
    expect(msg.textContent).toMatch(/Invalid API key.*sk-ant/);
    // Raw JSON content should not be rendered to the user.
    expect(msg.textContent).not.toContain("authentication_error");
  });

  it("renders the vLLM base URL field with a Test button", () => {
    render(withProviders(<Step3Models config={null} />));
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
    // Two Test buttons exist (anthropic + vllm).
    expect(screen.getAllByRole("button", { name: /^test$/i }).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("renders vLLM connection-refused as an amber warn (not a hard error)", async () => {
    responses["/api/setup/test-vllm"] = {
      ok: false,
      error: "connection refused: tcp/localhost:8001",
      latency_ms: null,
      detail: null,
    };
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    // Click the second Test (vLLM).
    await user.click(testButtons[1]);
    await waitFor(() => {
      expect(screen.getByTestId("vllm-error-message")).toBeInTheDocument();
    });
    const msg = screen.getByTestId("vllm-error-message");
    expect(msg.className).toMatch(/amber/);
    expect(msg.className).not.toMatch(/text-red-600/);
    expect(msg.textContent).toMatch(/No local vLLM/);
  });

  it("auto-saves use_local_embedding toggle wrapped as {models: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    // Three toggles render — find the local embedding one by its label
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    // Click the first to flip use_local_embedding to false
    await user.click(switches[0]);
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    const data = (last.body as { data: { models: { use_local_embedding: boolean } } }).data;
    expect(data).toHaveProperty("models");
    expect(data.models.use_local_embedding).toBe(false);
  });

  it("auto-saves vllm_base_url edits wrapped as {models: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const url = screen.getByLabelText(/base url/i);
    await user.clear(url);
    await user.type(url, "http://10.0.0.5:8001");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    const data = (last.body as { data: { models: { vllm_base_url: string } } }).data;
    expect(data.models.vllm_base_url).toBe("http://10.0.0.5:8001");
  });

  it("anthropic Test is disabled when the key is empty", () => {
    render(withProviders(<Step3Models config={null} />));
    const testButtons = screen.getAllByRole("button", { name: /^test$/i });
    expect(testButtons[0]).toBeDisabled();
  });
});
