import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step2VectorDB } from "./Step2VectorDB";

const originalFetch = globalThis.fetch;
let captured: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function mockFetch(testResponse?: Record<string, unknown>) {
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
    if (u.includes("/api/setup/test-vectordb")) {
      return new Response(
        JSON.stringify(
          testResponse ?? { ok: true, error: null, latency_ms: 23, detail: null },
        ),
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

describe("Step2VectorDB", () => {
  it("renders all six adapter options", () => {
    render(withProviders(<Step2VectorDB config={null} />));
    expect(screen.getByRole("button", { name: /ChromaDB/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Qdrant/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pinecone/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Weaviate/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pgvector/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Other.*custom/i })).toBeInTheDocument();
  });

  it("defaults to chroma selected", () => {
    render(withProviders(<Step2VectorDB config={null} />));
    const chromaBtn = screen.getByRole("button", { name: /ChromaDB/ });
    expect(chromaBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("shows Chroma config when chroma is selected", () => {
    render(withProviders(<Step2VectorDB config={null} />));
    expect(screen.getByLabelText(/chroma path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/collection name/i)).toBeInTheDocument();
  });

  it("shows qdrant config when qdrant is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Qdrant/ }));
    expect(screen.getByLabelText(/qdrant url/i)).toBeInTheDocument();
  });

  it("shows pinecone fields when pinecone is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Pinecone/ }));
    expect(screen.getByLabelText(/index name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^cloud$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^region$/i)).toBeInTheDocument();
  });

  it("shows weaviate fields when weaviate is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Weaviate/ }));
    expect(screen.getByLabelText(/weaviate url/i)).toBeInTheDocument();
  });

  it("shows pgvector fields when pgvector is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /pgvector/ }));
    expect(screen.getByLabelText(/postgres dsn/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/table name/i)).toBeInTheDocument();
  });

  it("shows module + class fields and docs link when Other is selected", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Other.*custom/i }));
    expect(screen.getByLabelText(/module path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/class name/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /docs\/custom-adapter\.md/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/AllanWessels/Bratan/blob/main/docs/custom-adapter.md",
    );
  });

  it("Test connection posts to /api/setup/test-vectordb with the chosen adapter", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /test connection/i }));
    const calls = captured.filter((c) => c.url.includes("/api/setup/test-vectordb"));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((calls[0].body as { adapter: string }).adapter).toBe("chroma");
  });

  it("Test connection includes the chosen adapter in payload after switching", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Qdrant/ }));
    await user.click(screen.getByRole("button", { name: /test connection/i }));
    const calls = captured.filter((c) => c.url.includes("/api/setup/test-vectordb"));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls.at(-1)!;
    expect((last.body as { adapter: string }).adapter).toBe("qdrant");
  });

  it("auto-saves vector_db changes wrapped as {vector_db: {...}}", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    const collection = screen.getByLabelText(/collection name/i);
    await user.clear(collection);
    await user.type(collection, "my-coll");
    await flushAutoSave();
    const saves = captured.filter((c) => c.url.includes("/api/setup/save-step"));
    expect(saves.length).toBeGreaterThan(0);
    const last = saves.at(-1)!;
    expect(last.body).toHaveProperty("step", 2);
    const data = (last.body as { data: { vector_db: { chroma_collection: string } } }).data;
    expect(data.vector_db.chroma_collection).toBe("my-coll");
  });
});
