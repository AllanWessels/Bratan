import { cn } from "@/lib/cn";

export type ConnectionState = "idle" | "testing" | "ok" | "fail" | "warn";

interface ConnectionBadgeProps {
  state: ConnectionState;
  label?: string;
  latencyMs?: number | null;
}

export function ConnectionBadge({ state, label, latencyMs }: ConnectionBadgeProps) {
  const dot =
    state === "ok"
      ? "bg-emerald-500"
      : state === "fail"
        ? "bg-red-500"
        : state === "warn"
          ? "bg-amber-500"
          : state === "testing"
            ? "bg-amber-400 animate-pulse"
            : "bg-slate-300";

  const text =
    label ??
    (state === "ok"
      ? "Connected"
      : state === "fail"
        ? "Failed"
        : state === "warn"
          ? "Not reachable"
          : state === "testing"
            ? "Testing..."
            : "Not tested");

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
      role="status"
    >
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden="true" />
      {text}
      {state === "ok" && latencyMs != null && (
        <span className="text-slate-500">({Math.round(latencyMs)}ms)</span>
      )}
    </span>
  );
}

/**
 * Turn an opaque Anthropic SDK error string into something a user can act on.
 * The SDK surfaces the upstream JSON body for HTTP errors, so we look for the
 * stable substrings rather than parsing structured fields.
 */
export function explainAnthropicError(error: string | null | undefined): string {
  if (!error) return "Test failed for an unknown reason.";
  const lower = error.toLowerCase();
  if (lower.includes("authentication_error") || lower.includes("401") || lower.includes("invalid x-api-key")) {
    return "Invalid API key — check the one you pasted is the full sk-ant-… string.";
  }
  if (lower.includes("permission_error") || lower.includes("403")) {
    return "Key is valid but lacks access to this model. Check your Anthropic console.";
  }
  if (lower.includes("rate_limit") || lower.includes("429")) {
    return "Rate-limited by Anthropic. Wait a few seconds and try again.";
  }
  if (lower.includes("not_found_error") || lower.includes("404")) {
    return "Model not found. Check the Oracle model id below.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Anthropic didn't respond within 10 seconds. Check your network.";
  }
  if (
    lower.includes("connection") ||
    lower.includes("connect") ||
    lower.includes("network") ||
    lower.includes("name or service not known") ||
    lower.includes("getaddrinfo")
  ) {
    return "Couldn't reach Anthropic. Check your network.";
  }
  // Last resort — show a trimmed slice so the badge isn't crowded by JSON.
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

/**
 * vLLM is *optional* — most users won't have it running. Render
 * connection-refused as a soft warning rather than a hard failure, since the
 * setup wizard's pre-judge can also be disabled in Step 3.
 */
export interface VLLMDiagnosis {
  severity: "warn" | "error";
  message: string;
}

export function explainVLLMError(error: string | null | undefined): VLLMDiagnosis {
  if (!error) {
    return { severity: "error", message: "Test failed for an unknown reason." };
  }
  const lower = error.toLowerCase();
  if (
    lower.includes("connection refused") ||
    lower.includes("connecterror") ||
    lower.includes("all connection attempts failed") ||
    lower.includes("name or service not known") ||
    lower.includes("getaddrinfo") ||
    lower.includes("nodename nor servname")
  ) {
    return {
      severity: "warn",
      message:
        "No local vLLM server reachable — that's fine if you're using the API-only mode. Toggle \"use local pre-judge\" OFF in Step 3 if you don't want this warning.",
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      severity: "warn",
      message: "vLLM didn't respond in time. Confirm the base URL and port.",
    };
  }
  if (lower.includes("http 4") || lower.includes("http 5")) {
    return {
      severity: "error",
      message: error.length > 160 ? `${error.slice(0, 160)}…` : error,
    };
  }
  return {
    severity: "error",
    message: error.length > 160 ? `${error.slice(0, 160)}…` : error,
  };
}
