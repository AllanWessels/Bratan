import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  ConnectionBadge,
  explainAnthropicError,
  explainVLLMError,
} from "./ConnectionBadge";

describe("ConnectionBadge", () => {
  it("renders 'Not tested' for idle state", () => {
    render(<ConnectionBadge state="idle" />);
    expect(screen.getByText(/Not tested/)).toBeInTheDocument();
  });

  it("renders 'Connected' + latency for ok state", () => {
    render(<ConnectionBadge state="ok" latencyMs={123} />);
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
    expect(screen.getByText(/123ms/)).toBeInTheDocument();
  });

  it("renders 'Failed' for fail state", () => {
    render(<ConnectionBadge state="fail" />);
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
  });

  it("renders 'Not reachable' for warn state (vLLM)", () => {
    render(<ConnectionBadge state="warn" />);
    expect(screen.getByText(/Not reachable/)).toBeInTheDocument();
  });

  it("renders 'Testing...' for testing state", () => {
    render(<ConnectionBadge state="testing" />);
    expect(screen.getByText(/Testing/)).toBeInTheDocument();
  });

  it("respects a custom label prop", () => {
    render(<ConnectionBadge state="ok" label="Live" latencyMs={5} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});

describe("explainAnthropicError", () => {
  it("returns a default for null/undefined", () => {
    expect(explainAnthropicError(null)).toMatch(/unknown reason/);
    expect(explainAnthropicError(undefined)).toMatch(/unknown reason/);
  });

  it("maps 401 / authentication_error to a humane key-paste hint", () => {
    expect(
      explainAnthropicError("authentication_error: invalid x-api-key").toLowerCase(),
    ).toMatch(/invalid api key/);
    expect(explainAnthropicError("HTTP 401 something")).toMatch(/Invalid API key/);
  });

  it("maps permission_error / 403 to a model-access hint", () => {
    expect(explainAnthropicError("permission_error: nope")).toMatch(/lacks access/);
  });

  it("maps rate_limit / 429 to a wait-and-retry hint", () => {
    expect(explainAnthropicError("rate_limit_error")).toMatch(/Rate-limited/);
    expect(explainAnthropicError("HTTP 429")).toMatch(/Rate-limited/);
  });

  it("maps 404 / not_found_error to a 'check the model id' hint", () => {
    expect(explainAnthropicError("not_found_error: model")).toMatch(/Model not found/);
  });

  it("maps timeout to a network-check hint", () => {
    expect(explainAnthropicError("Connection timed out")).toMatch(/didn't respond/);
  });

  it("maps connection/network strings to a network-check hint", () => {
    expect(explainAnthropicError("connection refused")).toMatch(/Couldn't reach Anthropic/);
    expect(explainAnthropicError("getaddrinfo ENOTFOUND")).toMatch(/Couldn't reach Anthropic/);
  });

  it("truncates very long unknown errors", () => {
    const longErr = "x".repeat(500);
    const out = explainAnthropicError(longErr);
    expect(out.length).toBeLessThan(longErr.length);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("explainVLLMError", () => {
  it("labels connection refused as a warn (vLLM is optional)", () => {
    const d = explainVLLMError("connection refused");
    expect(d.severity).toBe("warn");
    expect(d.message).toMatch(/No local vLLM/);
  });

  it("labels DNS failure as a warn too", () => {
    const d = explainVLLMError("getaddrinfo ENOTFOUND vllm-prod.local");
    expect(d.severity).toBe("warn");
  });

  it("labels timeout as warn with a helpful message", () => {
    const d = explainVLLMError("timeout reading from socket");
    expect(d.severity).toBe("warn");
    expect(d.message).toMatch(/didn't respond/);
  });

  it("treats HTTP 4xx/5xx as a hard error", () => {
    const d = explainVLLMError("HTTP 500 internal server error");
    expect(d.severity).toBe("error");
  });

  it("falls back to error severity for unknown strings", () => {
    const d = explainVLLMError("something weird");
    expect(d.severity).toBe("error");
  });
});
