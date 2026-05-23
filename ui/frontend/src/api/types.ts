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

// Vector DB adapter enum
export const VECTOR_DB_ADAPTERS = [
  "chroma",
  "qdrant",
  "pinecone",
  "weaviate",
  "pgvector",
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
  qdrant_url?: string | null;
  qdrant_api_key?: string | null;
  pinecone_api_key?: string | null;
  pinecone_index?: string | null;
  weaviate_url?: string | null;
  pgvector_dsn?: string | null;
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

export interface IngestStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  task_id: string | null;
  files_total: number;
  files_done: number;
  chunks_written: number;
  error: string | null;
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
