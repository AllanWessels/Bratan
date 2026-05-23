"""Pydantic schemas — the wire contract between FastAPI backend and the React frontend.

This file is the single source of truth for the M1 API. FastAPI auto-generates OpenAPI
from these models; the frontend consumes a typed client generated from that OpenAPI
schema. Both agents (backend, frontend) read this file first.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Failure categories (must mirror test_cases/schema.md)
# ---------------------------------------------------------------------------


class FailureCategory(str, Enum):
    """Failure categories — kept aligned with test_cases/schema.md (the human anchor)."""

    PARAPHRASE_BRITTLENESS = "paraphrase_brittleness"
    MULTI_HOP = "multi_hop"
    STRUCTURED_CONTENT = "structured_content"
    TEMPORAL_REASONING = "temporal_reasoning"
    NEGATION_OR_SCOPE = "negation_or_scope"
    DISAMBIGUATION = "disambiguation"
    OUT_OF_SCOPE = "out_of_scope"
    STRAIGHTFORWARD = "straightforward"


# ---------------------------------------------------------------------------
# Setup wizard
# ---------------------------------------------------------------------------


class VectorDBAdapter(str, Enum):
    CHROMA = "chroma"
    QDRANT = "qdrant"       # scaffolded in M1, functional in M5
    PINECONE = "pinecone"   # M5
    WEAVIATE = "weaviate"   # M5
    PGVECTOR = "pgvector"   # M5


class StopCriteria(BaseModel):
    convergence_threshold: float = Field(0.02, ge=0.0, le=1.0)
    convergence_window: int = Field(5, ge=1)
    max_iterations: int = Field(50, ge=1)
    anchor_regression_threshold: float = Field(0.3, ge=0.0, le=1.0)
    regression_policy: Literal["block", "warn"] = "warn"


class JudgeWeights(BaseModel):
    correctness: float = Field(0.4, ge=0.0, le=1.0)
    recall_at_5: float = Field(0.3, ge=0.0, le=1.0)
    faithfulness: float = Field(0.3, ge=0.0, le=1.0)


class CostCeilings(BaseModel):
    usd_per_run: float = Field(5.0, ge=0.0)
    tokens_per_iteration: int = Field(2_000_000, ge=0)
    cache_ttl_hours: int = Field(168, ge=0)
    subset_eval_size: int = Field(10, ge=1)


class ModelConfig(BaseModel):
    anthropic_api_key: str = ""
    oracle_model: str = "claude-sonnet-4-20250514"
    vllm_base_url: str = "http://localhost:8001"
    prejudge_model: str = "Qwen/Qwen2.5-14B-Instruct-AWQ"
    embedding_model: str = "BAAI/bge-large-en-v1.5"
    reranker_model: str = "BAAI/bge-reranker-v2-m3"
    use_local_embedding: bool = True
    use_local_reranker: bool = True
    use_local_prejudge: bool = True


class VectorDBConfig(BaseModel):
    adapter: VectorDBAdapter = VectorDBAdapter.CHROMA
    chroma_path: str = "./.chroma"
    chroma_collection: str = "corpus"
    # other adapters store their own fields here in M5
    qdrant_url: str | None = None
    qdrant_api_key: str | None = None
    pinecone_api_key: str | None = None
    pinecone_index: str | None = None
    weaviate_url: str | None = None
    pgvector_dsn: str | None = None


class ProjectBasics(BaseModel):
    project_name: str = "rag-refiner"
    corpus_path: str = "./corpus"
    seed_target_n: int = Field(50, ge=10, le=500)


class BratanConfig(BaseModel):
    """The complete project config written to bratan.config.yaml by the setup wizard."""

    project: ProjectBasics = ProjectBasics()
    vector_db: VectorDBConfig = VectorDBConfig()
    models: ModelConfig = ModelConfig()
    cost: CostCeilings = CostCeilings()
    stop: StopCriteria = StopCriteria()
    judge_weights: JudgeWeights = JudgeWeights()
    setup_completed: bool = False
    setup_completed_at: datetime | None = None


# ---- Setup wizard endpoints ----


class SetupState(BaseModel):
    config_exists: bool
    setup_completed: bool
    current_step: int = 1
    total_steps: int = 8
    completed_steps: list[int] = []


class GPUInfo(BaseModel):
    detected: bool
    name: str | None = None
    vram_total_mb: int | None = None
    vram_free_mb: int | None = None


class ProbeResult(BaseModel):
    gpu: GPUInfo
    vllm_reachable: bool
    vllm_url: str
    anthropic_key_set: bool


class ConnectionTest(BaseModel):
    ok: bool
    error: str | None = None
    latency_ms: float | None = None
    detail: dict | None = None


class TestVectorDBRequest(BaseModel):
    adapter: VectorDBAdapter
    config: VectorDBConfig


class TestAnthropicRequest(BaseModel):
    api_key: str
    model: str = "claude-sonnet-4-20250514"


class TestVLLMRequest(BaseModel):
    base_url: str
    model: str | None = None


class SaveStepRequest(BaseModel):
    step: int = Field(ge=1, le=8)
    data: dict


class SaveStepResponse(BaseModel):
    ok: bool
    config: BratanConfig


# ---------------------------------------------------------------------------
# Corpus + ingest
# ---------------------------------------------------------------------------


class CorpusFile(BaseModel):
    path: str
    size_bytes: int
    modified: datetime
    ingested: bool
    n_chunks: int | None = None


class CorpusSearchRequest(BaseModel):
    query: str
    k: int = Field(10, ge=1, le=100)


class Passage(BaseModel):
    """A passage returned from corpus retrieval — line numbers follow schema.md."""

    path: str
    line_start: int
    line_end: int
    content: str
    score: float | None = None


class CorpusSearchResponse(BaseModel):
    passages: list[Passage]
    embedding_model: str
    latency_ms: float


class IngestStatus(BaseModel):
    state: Literal["idle", "running", "succeeded", "failed"]
    task_id: str | None = None
    files_total: int = 0
    files_done: int = 0
    chunks_written: int = 0
    error: str | None = None


# ---------------------------------------------------------------------------
# Seed authoring
# ---------------------------------------------------------------------------


class PassageRef(BaseModel):
    """Reference to a passage in the corpus — field names follow test_cases/schema.md."""

    path: str
    line_start: int
    line_end: int


class SeedDraft(BaseModel):
    id: str  # client-side draft id (uuid4)
    question: str = ""
    ground_truth: str = ""
    passages: list[PassageRef] = []
    failure_category: FailureCategory | None = None
    notes: str = ""
    created_at: datetime
    updated_at: datetime


class SeedValidateRequest(BaseModel):
    question: str
    ground_truth: str
    passages: list[PassageRef]
    run_pipeline: bool = False


class SeedValidateResponse(BaseModel):
    passages_in_top_k: bool
    answer_text_in_passages: bool
    top_k_match_count: int = 0
    top_k_searched: int = 5
    pipeline_score: float | None = None
    pipeline_answer: str | None = None
    pipeline_retrieved: list[Passage] | None = None
    warnings: list[str] = []


class SeedSaveRequest(BaseModel):
    question: str
    ground_truth: str
    passages: list[PassageRef]
    failure_category: FailureCategory
    notes: str = ""
    draft_id: str | None = None  # optional reference back to draft to delete after save


class SeedCase(BaseModel):
    """Persisted shape — fields match test_cases/schema.md exactly."""

    id: str
    question: str
    ground_truth: str
    source_passages: list[PassageRef]
    failure_category: FailureCategory
    notes: str = ""
    hypothesis: str | None = None
    created_at: datetime
    created_by: Literal["human", "red-team"] = "human"


class SeedSaveResponse(BaseModel):
    ok: bool
    case: SeedCase
    total_cases: int
    target_n: int


class SeedListResponse(BaseModel):
    cases: list[SeedCase]
    target_n: int
    progress: float  # cases / target_n, clamped to 1.0
