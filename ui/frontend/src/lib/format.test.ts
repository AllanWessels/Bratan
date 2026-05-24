import { describe, expect, it } from "vitest";
import {
  failureCategoryDescription,
  formatBytes,
  formatPercent,
  formatTokens,
  formatUSD,
  prettyFailureCategory,
} from "./format";
import { FAILURE_CATEGORIES } from "@/api/types";

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
    ["straightforward", "Direct question"],
    ["paraphrase_brittleness", "Different words, same idea"],
    ["multi_hop", "Needs multiple passages"],
    ["structured_content", "Tables, lists, or code"],
    ["temporal_reasoning", "Time-sensitive question"],
    ["negation_or_scope", "What it isn't"],
    ["disambiguation", "Picking the right one"],
    ["out_of_scope", "Not in the corpus"],
  ])("returns the SME label for %s", (input, expected) => {
    expect(prettyFailureCategory(input)).toBe(expected);
  });

  it("falls back to title-case for unknown categories", () => {
    expect(prettyFailureCategory("brand_new_thing")).toBe("Brand New Thing");
  });

  it("provides a label for every known FailureCategory enum value", () => {
    for (const c of FAILURE_CATEGORIES) {
      const label = prettyFailureCategory(c);
      expect(label).toBeTruthy();
      // None of the friendly labels include underscores — that's the whole point.
      expect(label).not.toContain("_");
    }
  });
});

describe("failureCategoryDescription", () => {
  it.each([
    ["straightforward", "A regular question with a clear answer in the corpus."],
    [
      "paraphrase_brittleness",
      "The corpus uses different terminology than the question.",
    ],
    ["multi_hop", "The answer combines information from 2+ places."],
    ["structured_content", "The answer lives inside a table, list, or code block."],
    [
      "temporal_reasoning",
      "The answer depends on 'recent', 'last quarter', 'before X'.",
    ],
    [
      "negation_or_scope",
      "Asks what doesn't apply, or scopes the answer with 'except X'.",
    ],
    [
      "disambiguation",
      "Multiple similar things in the corpus; the right one must be chosen.",
    ],
    ["out_of_scope", "Answer isn't here — the pipeline should refuse, not invent."],
  ])("returns the description for %s", (input, expected) => {
    expect(failureCategoryDescription(input)).toBe(expected);
  });

  it("returns empty string for unknown categories", () => {
    expect(failureCategoryDescription("not_a_real_category")).toBe("");
  });
});
