/**
 * Types for the red-team-generated test-case browse endpoints.
 * Kept out of types.ts to avoid touching that file while another agent owns
 * the canonical OpenAPI mirror. Merge here on next codegen pass.
 */

export interface GeneratedFileSummary {
  timestamp: string;
  n_cases: number;
  file_path: string;
}
