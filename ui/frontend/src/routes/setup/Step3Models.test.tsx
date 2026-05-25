import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BratanConfig } from "@/api/types";

import { Step3Models } from "./Step3Models";

function makeConfig(useLocalPrejudge: boolean): BratanConfig {
  return {
    project: { project_name: "bratan", corpus_path: "./corpus", seed_target_n: 50 },
    vector_db: {
      adapter: "chroma",
      chroma_path: "./.chroma",
      chroma_collection: "corpus",
    },
    models: {
      anthropic_api_key: "",
      oracle_model: "claude-sonnet-4-6",
      vllm_base_url: "http://localhost:8001",
      prejudge_model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
      embedding_model: "BAAI/bge-small-en-v1.5",
      reranker_model: "BAAI/bge-reranker-v2-m3",
      use_local_embedding: true,
      use_local_reranker: true,
      use_local_prejudge: useLocalPrejudge,
    },
    cost: {
      usd_per_run: 5,
      tokens_per_iteration: 2_000_000,
      cache_ttl_hours: 168,
      subset_eval_size: 10,
    },
    stop: {
      convergence_threshold: 0.02,
      convergence_window: 5,
      max_iterations: 50,
      anchor_regression_threshold: 0.3,
      regression_policy: "warn",
    },
    judge_weights: { correctness: 0.4, recall_at_5: 0.3, faithfulness: 0.3 },
    setup_completed: false,
    setup_completed_at: null,
  };
}

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
    // Three checkboxes render — find the local embedding one by its label
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);
    // Click the first to flip use_local_embedding to false
    await user.click(checkboxes[0]);
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

  // ---- Regression for user-reported vLLM section confusion (2026-05-24) ----

  it("vLLM section spells out that it is OPTIONAL", () => {
    const { container } = render(withProviders(<Step3Models config={null} />));
    expect(screen.getByText(/Local vLLM endpoint \(optional\)/i)).toBeInTheDocument();
    // Description is split across multiple nodes (incl. <strong>). Verify
    // the body text in flattened form.
    const flat = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(flat).toMatch(/Only used if/i);
    expect(flat).toMatch(/Local pre-judge/i);
    expect(flat).toMatch(/toggled ON/i);
  });

  it("vLLM Base URL hint explains what amber means", () => {
    render(withProviders(<Step3Models config={null} />));
    // The hint copy mentions the amber warning explicitly.
    const hintMatch = screen.getByText(/amber warning/i);
    expect(hintMatch).toBeInTheDocument();
  });

  it("renders a 'you don't need vLLM right now' callout when prejudge toggle is OFF", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    // The default config has use_local_prejudge = true, so the callout is hidden.
    expect(
      screen.queryByText(/You don't need vLLM right now/i),
    ).not.toBeInTheDocument();
    // Toggle the pre-judge OFF.
    const prejudgeToggle = screen.getByLabelText(/Local pre-judge/i);
    await user.click(prejudgeToggle);
    // Now the explanatory callout should appear.
    expect(screen.getByText(/You don't need vLLM right now/i)).toBeInTheDocument();
  });

  // ---- "Get vLLM running" sub-card (auto-start + manual copy) ----

  it("auto-start sub-card renders only when Local pre-judge is ON", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    // Default: prejudge ON -> sub-card visible.
    expect(screen.getByTestId("get-vllm-running")).toBeInTheDocument();
    expect(screen.getByTestId("vllm-autostart-panel")).toBeInTheDocument();
    expect(screen.getByTestId("vllm-manual-panel")).toBeInTheDocument();

    // Toggle prejudge OFF -> sub-card disappears entirely.
    const prejudgeToggle = screen.getByLabelText(/Local pre-judge/i);
    await user.click(prejudgeToggle);
    expect(screen.queryByTestId("get-vllm-running")).not.toBeInTheDocument();
  });

  it("clicking 'Start vLLM server' POSTs to /api/system/vllm/start with model + port", async () => {
    responses["/api/system/vllm/status"] = {
      ok: true,
      // Stubbed status payload — VLLMStatus shape, but the mockFetch returns
      // whatever JSON we set, so we shape it like the real API.
      error: null,
      latency_ms: null,
      detail: null,
    } as unknown as TestResponse;
    // Note: the start mock just needs to return any JSON; the component reads
    // /api/system/vllm/status separately for state.
    const user = userEvent.setup();
    render(withProviders(<Step3Models config={null} />));
    const startBtn = screen.getByTestId("vllm-start-button");
    await user.click(startBtn);
    await waitFor(() => {
      const calls = captured.filter((c) => c.url.includes("/api/system/vllm/start"));
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    const call = captured.find((c) => c.url.includes("/api/system/vllm/start"))!;
    const body = call.body as { model: string; port: number };
    expect(body.model).toBe("Qwen/Qwen2.5-7B-Instruct-AWQ");
    expect(body.port).toBe(8001);
  });

  it("ready state turns the existing vLLM Test green automatically", async () => {
    // The status poll yields `state: "ready"` — the component should fire the
    // existing useTestVLLM mutation, which then receives `{ok: true}`.
    responses["/api/system/vllm/status"] = {
      state: "ready",
      model: "Qwen/Qwen2.5-7B-Instruct-AWQ",
      port: 8001,
      base_url: "http://localhost:8001",
      elapsed_s: 4.2,
      message: "vLLM is ready.",
    } as unknown as TestResponse;
    responses["/api/setup/test-vllm"] = {
      ok: true,
      error: null,
      latency_ms: 12,
      detail: { data: [] },
    };
    render(withProviders(<Step3Models config={null} />));
    // Wait for the polling status to land + the auto-fire to call test-vllm.
    await waitFor(
      () => {
        const calls = captured.filter((c) => c.url.includes("/api/setup/test-vllm"));
        expect(calls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 4000 },
    );
    // The Connection badge under "vllm-result" should resolve to OK.
    await waitFor(() => {
      const result = screen.getByTestId("vllm-result");
      // The OK ConnectionBadge has the word "OK" or a green dot — we look
      // for the absence of an error message and presence of latency display.
      expect(result.textContent ?? "").toMatch(/12|ms|ok/i);
    });
  });

  it("manual panel shows a copy-paste command matching the selected prejudge_model", () => {
    render(withProviders(<Step3Models config={null} />));
    const cmd = screen.getByTestId("vllm-manual-command");
    expect(cmd.textContent).toMatch(/vllm serve Qwen\/Qwen2\.5-7B-Instruct-AWQ --port 8001/);
  });

  it("vLLM 'Get vLLM running' card appears ABOVE 'Local vLLM endpoint (optional)' card", () => {
    // config={null} defaults use_local_prejudge=true, so both cards render.
    render(withProviders(<Step3Models config={null} />));
    const cards = screen.getAllByText(/Get vLLM running|Local vLLM endpoint/i);
    expect(cards.length).toBe(2);
    // First match (top of DOM) should be "Get vLLM running"
    expect(cards[0].textContent).toMatch(/Get vLLM running/i);
    expect(cards[1].textContent).toMatch(/Local vLLM endpoint/i);
  });

  // ---- Audit row 5: vLLM card hides on use_local_prejudge=false (config path) ----
  //
  // The existing "auto-start sub-card renders only when Local pre-judge is ON"
  // test drives the toggle CLICK to flip the card. These two tests cover the
  // controlled-prop / initial-render path: when the wizard mounts Step3Models
  // with config.use_local_prejudge=false, the GetVLLMRunningCard should be
  // absent from the start — not just hidden after a click.

  it("does NOT render the GetVLLMRunningCard when config.use_local_prejudge=false on mount", () => {
    render(withProviders(<Step3Models config={makeConfig(false)} />));
    expect(screen.queryByTestId("get-vllm-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vllm-autostart-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vllm-manual-panel")).not.toBeInTheDocument();
  });

  it("renders the GetVLLMRunningCard when config.use_local_prejudge=true on mount", () => {
    render(withProviders(<Step3Models config={makeConfig(true)} />));
    expect(screen.getByTestId("get-vllm-running")).toBeInTheDocument();
    expect(screen.getByTestId("vllm-autostart-panel")).toBeInTheDocument();
    expect(screen.getByTestId("vllm-manual-panel")).toBeInTheDocument();
  });

  it("renders the 'not installed' hint when the start endpoint returns vllm_not_installed", async () => {
    // Override fetch for this one test to send a 422 for /vllm/start.
    const origFetch = globalThis.fetch;
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
      if (u.includes("/api/system/vllm/start")) {
        return new Response(
          JSON.stringify({
            detail: {
              error: "vllm_not_installed",
              message:
                "The `vllm` CLI is not installed. Run `uv sync --extra gpu` to install the GPU extras, then try again.",
              hint: "uv sync --extra gpu",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, config: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const user = userEvent.setup();
      render(withProviders(<Step3Models config={null} />));
      await user.click(screen.getByTestId("vllm-start-button"));
      await waitFor(() => {
        expect(screen.getByTestId("vllm-not-installed-message")).toBeInTheDocument();
      });
      const msg = screen.getByTestId("vllm-not-installed-message");
      expect(msg.textContent).toMatch(/uv sync --extra gpu/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
