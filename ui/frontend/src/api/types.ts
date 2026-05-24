/**
 * Hand-written TypeScript mirror of ui/backend/schemas.py.
 * OpenAPI codegen replaces this in M5.
 */

// Failure categories — aligned with test_cases/schema.md (the human anchor).
export const FAILURE_CATEGORIES = [
  "paraphrase_brittleness",
  "multi_hop",
  "structured_content",
  "temporal_reasoning",
  "negation_or_scope",
  "disambiguation",
  "out_of_scope",
  "straightforward",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * Plain-language labels + descriptions for each failure category.
 *
 * The enum values in `test_cases/schema.md` are the wire-level contract and
 * stay as-is (RAG jargon is fine in the JSON). These labels are what the
 * subject-matter expert actually sees in the authoring UI — they need to
 * make sense to someone who knows the *content* of the corpus, not the
 * mechanics of retrieval.
 */
export const FAILURE_CATEGORY_LABELS: Record<
  FailureCategory,
  { label: string; description: string }
> = {
  straightforward: {
    label: "Direct question",
    description: "A regular question with a clear answer in the corpus.",
  },
  paraphrase_brittleness: {
    label: "Different words, same idea",
    description: "The corpus uses different terminology than the question.",
  },
  multi_hop: {
    label: "Needs multiple passages",
    description: "The answer combines information from 2+ places.",
  },
  structured_content: {
    label: "Tables, lists, or code",
    description: "The answer lives inside a table, list, or code block.",
  },
  temporal_reasoning: {
    label: "Time-sensitive question",
    description: "The answer depends on 'recent', 'last quarter', 'before X'.",
  },
  negation_or_scope: {
    label: "What it isn't",
    description: "Asks what doesn't apply, or scopes the answer with 'except X'.",
  },
  disambiguation: {
    label: "Picking the right one",
    description: "Multiple similar things in the corpus; the right one must be chosen.",
  },
  out_of_scope: {
    label: "Not in the corpus",
    description: "Answer isn't here — the pipeline should refuse, not invent.",
  },
};

// Vector DB adapter enum
export const VECTOR_DB_ADAPTERS = [
  "chroma",
  "qdrant",
  "pinecone",
  "weaviate",
  "pgvector",
  "other",
] as const;
export type VectorDBAdapter = (typeof VECTOR_DB_ADAPTERS)[number];

export interface StopCriteria {
  convergence_threshold: number;
  convergence_window: number;
  max_iterations: number;
  anchor_regression_threshold: number;
  regression_policy: "block" | "warn";
}

export interface JudgeWeights {
  correctness: number;
  recall_at_5: number;
  faithfulness: number;
}

export interface CostCeilings {
  usd_per_run: number;
  tokens_per_iteration: number;
  cache_ttl_hours: number;
  subset_eval_size: number;
}

export interface ModelConfig {
  anthropic_api_key: string;
  oracle_model: string;
  vllm_base_url: string;
  prejudge_model: string;
  embedding_model: string;
  reranker_model: string;
  use_local_embedding: boolean;
  use_local_reranker: boolean;
  use_local_prejudge: boolean;
}

export interface VectorDBConfig {
  adapter: VectorDBAdapter;
  chroma_path: string;
  chroma_collection: string;
  // Qdrant
  qdrant_url?: string | null;
  qdrant_api_key?: string | null;
  // Pinecone
  pinecone_api_key?: string | null;
  pinecone_index?: string | null;
  pinecone_cloud?: string;
  pinecone_region?: string;
  pinecone_namespace?: string;
  // Weaviate
  weaviate_url?: string | null;
  weaviate_api_key?: string | null;
  weaviate_collection?: string;
  // pgvector
  pgvector_dsn?: string | null;
  pgvector_table?: string;
  // Other — user-provided VectorDBAdapter subclass.
  other_adapter_module?: string | null;
  other_adapter_class?: string | null;
}

export interface ProjectBasics {
  project_name: string;
  corpus_path: string;
  seed_target_n: number;
}

export interface BratanConfig {
  project: ProjectBasics;
  vector_db: VectorDBConfig;
  models: ModelConfig;
  cost: CostCeilings;
  stop: StopCriteria;
  judge_weights: JudgeWeights;
  setup_completed: boolean;
  setup_completed_at: string | null;
}

export interface SetupState {
  config_exists: boolean;
  setup_completed: boolean;
  current_step: number;
  total_steps: number;
  completed_steps: number[];
}

export interface GPUInfo {
  detected: boolean;
  name: string | null;
  vram_total_mb: number | null;
  vram_free_mb: number | null;
}

export interface ProbeResult {
  gpu: GPUInfo;
  vllm_reachable: boolean;
  vllm_url: string;
  anthropic_key_set: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  error: string | null;
  latency_ms: number | null;
  detail: Record<string, unknown> | null;
}

export interface TestVectorDBRequest {
  adapter: VectorDBAdapter;
  config: VectorDBConfig;
}

export interface TestAnthropicRequest {
  api_key: string;
  model?: string;
}

export interface TestVLLMRequest {
  base_url: string;
  model?: string | null;
}

export interface SaveStepRequest {
  step: number;
  data: Record<string, unknown>;
}

export interface SaveStepResponse {
  ok: boolean;
  config: BratanConfig;
}

// Corpus
export interface CorpusFile {
  path: string;
  size_bytes: number;
  modified: string;
  ingested: boolean;
  n_chunks: number | null;
}

export interface CorpusSearchRequest {
  query: string;
  k: number;
}

export interface Passage {
  path: string;
  line_start: number;
  line_end: number;
  content: string;
  score: number | null;
}

export interface CorpusSearchResponse {
  passages: Passage[];
  embedding_model: string;
  latency_ms: number;
}

export interface CorpusPassagesResponse {
  passages: Passage[];
  total: number;
  offset: number;
  limit: number;
  window_lines: number;
}

export interface IngestStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  task_id: string | null;
  files_total: number;
  files_done: number;
  chunks_written: number;
  error: string | null;
  current_file?: string | null;
  chunks_per_sec?: number | null;
}

// Seed authoring — PassageRef field names follow test_cases/schema.md
export interface PassageRef {
  path: string;
  line_start: number;
  line_end: number;
}

export interface SeedDraft {
  id: string;
  question: string;
  ground_truth: string;
  passages: PassageRef[];
  failure_category: FailureCategory | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface SeedValidateRequest {
  question: string;
  ground_truth: string;
  passages: PassageRef[];
  run_pipeline: boolean;
}

export interface SeedValidateResponse {
  passages_in_top_k: boolean;
  answer_text_in_passages: boolean;
  top_k_match_count: number;
  top_k_searched: number;
  pipeline_score: number | null;
  pipeline_answer: string | null;
  pipeline_retrieved: Passage[] | null;
  warnings: string[];
}

export interface SeedSaveRequest {
  question: string;
  ground_truth: string;
  passages: PassageRef[];
  failure_category: FailureCategory;
  notes: string;
  draft_id: string | null;
}

export interface SeedCase {
  id: string;
  question: string;
  ground_truth: string;
  source_passages: PassageRef[];
  failure_category: FailureCategory;
  notes: string;
  hypothesis: string | null;
  created_at: string;
  created_by: "human" | "red-team";
}

export interface SeedSaveResponse {
  ok: boolean;
  case: SeedCase;
  total_cases: number;
  target_n: number;
}

export interface SeedListResponse {
  cases: SeedCase[];
  target_n: number;
  progress: number;
}

// ---------------------------------------------------------------------------
// M2 — IterationReport + loop control
// ---------------------------------------------------------------------------

export const STOP_REASONS = [
  "convergence",
  "budget",
  "max_iterations",
  "anchor_regression",
  "judge_drift",
  "blue_stall",
  "manual",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface CostBlock {
  oracle_calls: number;
  prejudge_calls: number;
  cache_hits: number;
  usd_spent: number;
  tokens_in: number;
  tokens_out: number;
}

export interface LatencyBlock {
  p50_total_ms: number;
  p95_total_ms: number;
  p50_retrieval_ms: number;
  p95_retrieval_ms: number;
  p50_generation_ms: number;
  p95_generation_ms: number;
}

export interface DriftBlock {
  samples_checked: number;
  disagreement_rate: number;
}

export interface CategoryStats {
  count: number;
  avg_composite: number;
  pass_rate: number;
}

export interface CaseScore {
  case_id: string;
  composite: number;
  retrieval_recall_at_5: number;
  answer_correctness: number | null;
  faithfulness: number | null;
  failure_category: FailureCategory;
  judge_mode: string;
  latency_ms: number;
}

export interface Regression {
  case_id: string;
  previous: number;
  current: number;
}

export interface IterationReport {
  timestamp: string;
  iteration: number;
  pipeline_manifest_hash: string;
  test_set_size: number;
  composite_mean: number;
  composite_stdev: number;
  pass_rate_at_0_6: number;
  per_category: Record<string, CategoryStats>;
  regressions: Regression[];
  recoveries: string[];
  by_case: CaseScore[];
  cost: CostBlock;
  latency: LatencyBlock;
  drift: DriftBlock;
  judge_weights_hash: string;
  low_confidence_verdicts: Array<Record<string, unknown>>;
  stop_reason: StopReason | null;
}

export interface ReportSummary {
  timestamp: string;
  iteration: number;
  composite_mean: number;
  pass_rate_at_0_6: number;
  stop_reason: StopReason | null;
}

export interface LoopStartRequest {
  iterations: number;
  budget_usd: number | null;
  skip_red: boolean;
  no_agents: boolean;
}

export interface LoopStartResponse {
  task_id: string;
  started_at: string;
}

export interface LoopStopResponse {
  ok: boolean;
  was_running: boolean;
}

export interface LoopStatus {
  running: boolean;
  task_id: string | null;
  current_iteration: number | null;
  started_at: string | null;
  iterations_requested: number;
  last_report_ts: string | null;
}

export type LoopStreamEventType = "iteration_complete" | "loop_stopped" | "error";

export interface LoopStreamEvent {
  type: LoopStreamEventType;
  report: IterationReport | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// vLLM lifecycle (managed local server for the pre-judge)
// ---------------------------------------------------------------------------

export type VLLMState = "stopped" | "starting" | "downloading" | "ready" | "failed";

export interface VLLMStatus {
  state: VLLMState;
  model: string | null;
  port: number | null;
  base_url: string | null;
  elapsed_s: number;
  message: string | null;
}

export interface VLLMStartRequest {
  model: string;
  port: number;
}

export interface VLLMStopResponse {
  ok: boolean;
  was_running: boolean;
}
