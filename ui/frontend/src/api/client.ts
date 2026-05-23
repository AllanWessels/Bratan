/**
 * Tiny fetch wrapper. Throws BackendError on non-2xx; returns parsed JSON otherwise.
 *
 * The single `any` allowance for this project lives in the generic body type — the
 * shape is constrained at every call site by `api/hooks.ts`.
 */

export class BackendError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.detail = detail;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new BackendError(
      `Network error: ${e instanceof Error ? e.message : String(e)}`,
      0,
      null,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "detail" in parsed
        ? extractDetailMessage((parsed as { detail: unknown }).detail)
        : null) ?? `HTTP ${res.status} ${res.statusText}`;
    throw new BackendError(message, res.status, parsed);
  }

  return parsed as T;
}

function extractDetailMessage(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "message" in detail) {
    const m = (detail as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return null;
}
