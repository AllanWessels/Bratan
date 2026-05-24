import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Step2VectorDB } from "./Step2VectorDB";

/**
 * Exercises every adapter radio, every text input across the six adapter
 * panels, and the Test connection button. Each assertion proves both that
 * (a) the panel re-renders after a radio click and (b) the field edits are
 * captured in the autosave payload.
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
    if (u.includes("/api/setup/test-vectordb")) {
      return new Response(
        JSON.stringify({ ok: true, error: null, latency_ms: 17, detail: null }),
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

describe("Step2VectorDB actuation — every adapter radio + every field", () => {
  it("clicking ChromaDB shows the Chroma panel and aria-pressed flips to true", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    // Default is chroma — click Qdrant first to verify the click really does work.
    await user.click(screen.getByRole("button", { name: /Qdrant/ }));
    expect(screen.queryByLabelText(/chroma path/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /ChromaDB/ }));
    expect(screen.getByLabelText(/chroma path/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ChromaDB/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking Qdrant reveals the URL + API key fields", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Qdrant/ }));
    expect(screen.getByLabelText(/qdrant url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^api key/i)).toBeInTheDocument();
  });

  it("typing a Qdrant URL updates the autosave payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Qdrant/ }));
    await user.type(screen.getByLabelText(/qdrant url/i), "http://qdrant:6333");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as { data: { vector_db: { qdrant_url: string } } }).data;
    expect(data.vector_db.qdrant_url).toBe("http://qdrant:6333");
  });

  it("typing a Pinecone API key + index name updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Pinecone/ }));
    await user.type(screen.getByLabelText(/^api key/i), "pc-secret");
    await user.type(screen.getByLabelText(/index name/i), "bratan-prod");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: { vector_db: { pinecone_api_key: string; pinecone_index: string } };
    }).data;
    expect(data.vector_db.pinecone_api_key).toBe("pc-secret");
    expect(data.vector_db.pinecone_index).toBe("bratan-prod");
  });

  it("typing Pinecone cloud + region + namespace updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Pinecone/ }));
    await user.clear(screen.getByLabelText(/^cloud$/i));
    await user.type(screen.getByLabelText(/^cloud$/i), "gcp");
    await user.clear(screen.getByLabelText(/^region$/i));
    await user.type(screen.getByLabelText(/^region$/i), "us-central1");
    await user.type(screen.getByLabelText(/namespace/i), "tenant-a");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: {
        vector_db: {
          pinecone_cloud: string;
          pinecone_region: string;
          pinecone_namespace: string;
        };
      };
    }).data;
    expect(data.vector_db.pinecone_cloud).toBe("gcp");
    expect(data.vector_db.pinecone_region).toBe("us-central1");
    expect(data.vector_db.pinecone_namespace).toBe("tenant-a");
  });

  it("typing a Weaviate URL + API key updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Weaviate/ }));
    await user.type(screen.getByLabelText(/weaviate url/i), "https://wv.example");
    await user.type(screen.getByLabelText(/^api key/i), "wv-secret");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: { vector_db: { weaviate_url: string; weaviate_api_key: string } };
    }).data;
    expect(data.vector_db.weaviate_url).toBe("https://wv.example");
    expect(data.vector_db.weaviate_api_key).toBe("wv-secret");
  });

  it("typing a pgvector DSN + table updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /pgvector/ }));
    await user.type(
      screen.getByLabelText(/postgres dsn/i),
      "postgresql://u:p@db:5432/bratan",
    );
    await user.clear(screen.getByLabelText(/table name/i));
    await user.type(screen.getByLabelText(/table name/i), "chunks");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: { vector_db: { pgvector_dsn: string; pgvector_table: string } };
    }).data;
    expect(data.vector_db.pgvector_dsn).toBe("postgresql://u:p@db:5432/bratan");
    expect(data.vector_db.pgvector_table).toBe("chunks");
  });

  it("typing module + class for Other custom adapter updates the payload", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.click(screen.getByRole("button", { name: /Other.*custom/i }));
    await user.type(
      screen.getByLabelText(/module path/i),
      "myproject.adapters.milvus",
    );
    await user.type(screen.getByLabelText(/class name/i), "MilvusAdapter");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: {
        vector_db: { other_adapter_module: string; other_adapter_class: string };
      };
    }).data;
    expect(data.vector_db.other_adapter_module).toBe("myproject.adapters.milvus");
    expect(data.vector_db.other_adapter_class).toBe("MilvusAdapter");
  });

  it("Test connection fires for every adapter in turn", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    for (const name of [
      /Qdrant/,
      /Pinecone/,
      /Weaviate/,
      /pgvector/,
      /Other.*custom/i,
      /ChromaDB/,
    ]) {
      await user.click(screen.getByRole("button", { name }));
      await user.click(screen.getByRole("button", { name: /test connection/i }));
    }
    const tests = captured.filter((c) => c.url.includes("/api/setup/test-vectordb"));
    expect(tests.length).toBe(6);
    expect(tests.map((t) => (t.body as { adapter: string }).adapter)).toEqual([
      "qdrant",
      "pinecone",
      "weaviate",
      "pgvector",
      "other",
      "chroma",
    ]);
  });

  it("editing Chroma path then collection name produces a save with both values", async () => {
    const user = userEvent.setup();
    render(withProviders(<Step2VectorDB config={null} />));
    await user.clear(screen.getByLabelText(/chroma path/i));
    await user.type(screen.getByLabelText(/chroma path/i), "./vec");
    await user.clear(screen.getByLabelText(/collection name/i));
    await user.type(screen.getByLabelText(/collection name/i), "alpha");
    await flushAutoSave();
    const save = captured
      .filter((c) => c.url.includes("/api/setup/save-step"))
      .at(-1)!;
    const data = (save.body as {
      data: { vector_db: { chroma_path: string; chroma_collection: string } };
    }).data;
    expect(data.vector_db.chroma_path).toBe("./vec");
    expect(data.vector_db.chroma_collection).toBe("alpha");
  });
});
