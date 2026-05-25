import { afterEach } from "vitest";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

/**
 * Integration-test helper for cross-query coupling tests.
 *
 * Sibling unit suites use `vi.mock("@/api/hooks", ...)` to swap each hook for
 * an independent puppet. That works for "what does this component render
 * given hook state X" assertions, but it hides the cache-coupling that
 * actually drives the 2026-05-24 ingest bug class: one hook's onSuccess
 * invalidates another query, and the consumer of THAT query re-fetches.
 *
 * This helper wires the real `QueryClient` and the real `useQuery` /
 * `useMutation` hooks; only the HTTP boundary (`fetch`) is stubbed. Tests
 * declare a URL→response map, then drive transitions by mutating that map
 * between renders.
 */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface StubbedRequest {
  method: Method;
  url: string;
  body: unknown;
}

/**
 * (method, url, body) -> JSON body the stubbed fetch returns. Throw to
 * simulate a 5xx-ish failure; the error propagates through `request` as a
 * `BackendError` with status 0 (matches the network-error branch the real
 * client uses today).
 */
export type RequestStub = (req: StubbedRequest) => unknown | Promise<unknown>;

export interface RenderWithQueryClientOptions extends Omit<RenderOptions, "wrapper"> {
  /** Stub for the `fetch`-backed http boundary. Required. */
  requestStub: RequestStub;
  /** Optional pre-seeded query client; defaults to a fresh one per render. */
  queryClient?: QueryClient;
}

export interface RenderWithQueryClientResult extends RenderResult {
  queryClient: QueryClient;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

export function renderWithQueryClient(
  ui: ReactElement,
  opts: RenderWithQueryClientOptions,
): RenderWithQueryClientResult {
  const queryClient =
    opts.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0 },
        mutations: { retry: false },
      },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = ((init?.method ?? "GET") as string).toUpperCase() as Method;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    try {
      const payload = await opts.requestStub({ method, url, body });
      return new Response(JSON.stringify(payload ?? null), { status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ detail: message }), { status: 500 });
    }
  }) as typeof fetch;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const result = render(ui, { ...opts, wrapper });
  return { ...result, queryClient };
}
