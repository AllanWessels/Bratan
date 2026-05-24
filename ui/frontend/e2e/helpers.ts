import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..", "..", "..");
export const CONFIG_PATH = path.join(PROJECT_ROOT, "bratan.config.yaml");
export const SETUP_SIDECAR_PATH = path.join(PROJECT_ROOT, ".bratan-setup.json");
export const SEED_PATH = path.join(PROJECT_ROOT, "test_cases", "seed.jsonl");
export const SEED_DRAFTS_DIR = path.join(PROJECT_ROOT, "test_cases", ".drafts");
export const CHROMA_PATH = path.join(PROJECT_ROOT, ".chroma");
export const REPORTS_HISTORY_DIR = path.join(PROJECT_ROOT, "reports", "history");
export const CORPUS_DIR = path.join(PROJECT_ROOT, "corpus");

/** Persisted shape of bratan.config.yaml. */
export interface BratanConfigYaml {
  project: {
    project_name: string;
    corpus_path: string;
    seed_target_n: number;
  };
  vector_db: {
    adapter: string;
    chroma_path: string;
    chroma_collection: string;
  };
  models: {
    anthropic_api_key: string;
    oracle_model: string;
    vllm_base_url: string;
    prejudge_model: string;
    embedding_model: string;
    reranker_model: string;
    use_local_embedding: boolean;
    use_local_reranker: boolean;
    use_local_prejudge: boolean;
  };
  cost: {
    usd_per_run: number;
    tokens_per_iteration: number;
    cache_ttl_hours: number;
    subset_eval_size: number;
  };
  stop: {
    convergence_threshold: number;
    convergence_window: number;
    max_iterations: number;
    anchor_regression_threshold: number;
    regression_policy: string;
  };
  judge_weights: {
    correctness: number;
    recall_at_5: number;
    faithfulness: number;
  };
  setup_completed: boolean;
  setup_completed_at?: string | null;
}

/** Persisted shape of a row in test_cases/seed.jsonl. */
export interface SeedCaseRow {
  id: string;
  question: string;
  ground_truth: string;
  source_passages: Array<{ path: string; line_start: number; line_end: number }>;
  failure_category: string;
  notes?: string;
  hypothesis?: string | null;
  created_at: string;
  created_by: "human" | "red-team";
}

export function readBratanConfig(): BratanConfigYaml {
  const text = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`bratan.config.yaml is empty or not a mapping: ${text}`);
  }
  return parsed as BratanConfigYaml;
}

export function readSeedJsonl(): SeedCaseRow[] {
  if (!fs.existsSync(SEED_PATH)) return [];
  const lines = fs.readFileSync(SEED_PATH, "utf-8").split("\n").filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as SeedCaseRow);
}

/** Best-effort recursive remove; ignores ENOENT. */
export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Wipe all state the wizard / authoring flow can write. */
export function resetBratanState(): void {
  rmrf(CONFIG_PATH);
  rmrf(SETUP_SIDECAR_PATH);
  rmrf(SEED_PATH);
  rmrf(SEED_DRAFTS_DIR);
  rmrf(CHROMA_PATH);
  if (fs.existsSync(REPORTS_HISTORY_DIR)) {
    for (const f of fs.readdirSync(REPORTS_HISTORY_DIR)) {
      if (f.startsWith("run-") && f.endsWith(".json")) {
        rmrf(path.join(REPORTS_HISTORY_DIR, f));
      }
    }
  }
}
