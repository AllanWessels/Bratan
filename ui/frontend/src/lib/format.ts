export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUSD(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatPercent(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

import { FAILURE_CATEGORY_LABELS, type FailureCategory } from "@/api/types";

/**
 * Human-friendly label for a failure category enum value.
 *
 * Looks up the SME-facing label from `FAILURE_CATEGORY_LABELS`. Unknown
 * values (e.g. a future category not yet in the frontend bundle) fall back
 * to the old title-case behavior so we never render a raw enum to the user.
 */
export function prettyFailureCategory(c: string): string {
  const entry = (FAILURE_CATEGORY_LABELS as Record<string, { label: string }>)[c];
  if (entry) return entry.label;
  return c
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Description (one-line "what does this mean?") for a failure category.
 *
 * Returns an empty string for unknown categories rather than inventing
 * verbiage, so callers can simply conditionally render.
 */
export function failureCategoryDescription(c: string): string {
  const entry = (
    FAILURE_CATEGORY_LABELS as Record<string, { description: string }>
  )[c];
  return entry?.description ?? "";
}

/** Re-export so callers can do their own lookups without re-importing. */
export { FAILURE_CATEGORY_LABELS };
export type { FailureCategory };
