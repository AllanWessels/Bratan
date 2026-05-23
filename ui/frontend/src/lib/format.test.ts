import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatPercent,
  formatTokens,
  formatUSD,
  prettyFailureCategory,
} from "./format";

describe("formatTokens", () => {
  it("returns raw count under 1000", () => {
    expect(formatTokens(999)).toBe("999");
  });
  it("uses k for thousands", () => {
    expect(formatTokens(1234)).toBe("1.2k");
  });
  it("uses M for millions", () => {
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });
});

describe("formatUSD", () => {
  it("formats with two decimals", () => {
    expect(formatUSD(3.5)).toBe("$3.50");
  });
});

describe("formatPercent", () => {
  it("multiplies by 100 and appends %", () => {
    expect(formatPercent(0.42)).toBe("42.0%");
  });
  it("respects digit count", () => {
    expect(formatPercent(0.42, 0)).toBe("42%");
  });
});

describe("formatBytes", () => {
  it("returns B under 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("uses KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
  it("uses MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("prettyFailureCategory", () => {
  it.each([
    ["paraphrase_brittleness", "Paraphrase Brittleness"],
    ["multi_hop", "Multi Hop"],
    ["structured_content", "Structured Content"],
    ["temporal_reasoning", "Temporal Reasoning"],
    ["negation_or_scope", "Negation Or Scope"],
    ["disambiguation", "Disambiguation"],
    ["out_of_scope", "Out Of Scope"],
    ["straightforward", "Straightforward"],
  ])("formats %s as %s", (input, expected) => {
    expect(prettyFailureCategory(input)).toBe(expected);
  });
});
