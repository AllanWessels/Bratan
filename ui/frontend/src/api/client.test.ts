import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError, request } from "./client";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("request", () => {
  it("parses JSON on 2xx", async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const body = await request<{ ok: boolean }>("/api/health");
    expect(body.ok).toBe(true);
  });

  it("appends query string when provided", async () => {
    let capturedUrl = "";
    mockFetch(async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    });
    await request("/api/corpus/passage", { query: { path: "a.md", start: 1, end: 5 } });
    expect(capturedUrl).toContain("/api/corpus/passage?");
    expect(capturedUrl).toContain("path=a.md");
    expect(capturedUrl).toContain("start=1");
    expect(capturedUrl).toContain("end=5");
  });

  it("serializes body for POST", async () => {
    let capturedBody: string | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = (init?.body as string) ?? null;
      return new Response("null", { status: 200 });
    });
    await request("/api/seed/save", { method: "POST", body: { question: "q" } });
    expect(JSON.parse(capturedBody as string)).toEqual({ question: "q" });
  });

  it("throws BackendError on non-2xx and surfaces the detail message", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ detail: "Bad request" }), { status: 400 }),
    );
    await expect(request("/api/x")).rejects.toBeInstanceOf(BackendError);
    try {
      await request("/api/x");
    } catch (e) {
      if (e instanceof BackendError) {
        expect(e.status).toBe(400);
        expect(e.message).toBe("Bad request");
      }
    }
  });

  it("falls back to HTTP status text when no detail", async () => {
    mockFetch(async () => new Response("", { status: 500, statusText: "Server Error" }));
    try {
      await request("/api/x");
      throw new Error("should have thrown");
    } catch (e) {
      if (e instanceof BackendError) {
        expect(e.message).toMatch(/HTTP 500/);
      }
    }
  });

  it("wraps network errors as BackendError with status 0", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    try {
      await request("/api/x");
    } catch (e) {
      expect(e).toBeInstanceOf(BackendError);
      if (e instanceof BackendError) {
        expect(e.status).toBe(0);
        expect(e.message).toMatch(/Network error/);
      }
    }
  });
});
