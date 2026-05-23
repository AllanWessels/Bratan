"""FastAPI app — setup wizard + corpus + seed-authoring endpoints.

This file defines the route signatures only. Each route delegates to a service module
that the backend agent fills in. The signatures are the wire contract.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ui.backend import config_store, seed_store, system_probe
from ui.backend.schemas import (
    BratanConfig,
    ConnectionTest,
    CorpusFile,
    CorpusSearchRequest,
    CorpusSearchResponse,
    IngestStatus,
    ProbeResult,
    SaveStepRequest,
    SaveStepResponse,
    SeedListResponse,
    SeedSaveRequest,
    SeedSaveResponse,
    SeedValidateRequest,
    SeedValidateResponse,
    SetupState,
    TestAnthropicRequest,
    TestVectorDBRequest,
    TestVLLMRequest,
)

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(os.environ.get("BRATAN_PROJECT_ROOT", Path(__file__).resolve().parents[2]))
CONFIG_PATH = PROJECT_ROOT / "bratan.config.yaml"

app = FastAPI(
    title="RAG Refiner",
    version="0.1.0",
    description="Self-improving RAG pipeline driven by red-team / blue-team / judge agents.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": "0.1.0"}


# ---------------------------------------------------------------------------
# Setup wizard
# ---------------------------------------------------------------------------


@app.get("/api/setup/state", response_model=SetupState)
def setup_state() -> SetupState:
    return config_store.get_setup_state(CONFIG_PATH)


@app.post("/api/setup/probe", response_model=ProbeResult)
def setup_probe() -> ProbeResult:
    return system_probe.run_full_probe()


@app.post("/api/setup/test-vectordb", response_model=ConnectionTest)
def setup_test_vectordb(req: TestVectorDBRequest) -> ConnectionTest:
    return system_probe.test_vectordb(req)


@app.post("/api/setup/test-anthropic", response_model=ConnectionTest)
def setup_test_anthropic(req: TestAnthropicRequest) -> ConnectionTest:
    return system_probe.test_anthropic(req)


@app.post("/api/setup/test-vllm", response_model=ConnectionTest)
def setup_test_vllm(req: TestVLLMRequest) -> ConnectionTest:
    return system_probe.test_vllm(req)


@app.post("/api/setup/save-step", response_model=SaveStepResponse)
def setup_save_step(req: SaveStepRequest) -> SaveStepResponse:
    return config_store.save_step(CONFIG_PATH, req.step, req.data)


@app.post("/api/setup/finish", response_model=BratanConfig)
def setup_finish() -> BratanConfig:
    return config_store.finish_setup(CONFIG_PATH)


@app.get("/api/config", response_model=BratanConfig)
def get_config() -> BratanConfig:
    return config_store.load(CONFIG_PATH)


@app.patch("/api/config", response_model=BratanConfig)
def patch_config(patch: dict) -> BratanConfig:
    return config_store.patch(CONFIG_PATH, patch)


# ---------------------------------------------------------------------------
# Corpus
# ---------------------------------------------------------------------------


@app.get("/api/corpus/files", response_model=list[CorpusFile])
def corpus_files() -> list[CorpusFile]:
    cfg = config_store.load(CONFIG_PATH)
    from pipeline import ingest

    return ingest.list_corpus(Path(cfg.project.corpus_path))


@app.post("/api/corpus/search", response_model=CorpusSearchResponse)
def corpus_search(req: CorpusSearchRequest) -> CorpusSearchResponse:
    cfg = config_store.load(CONFIG_PATH)
    from pipeline import query

    return query.search_corpus(cfg, req.query, req.k)


@app.get("/api/corpus/passage")
def corpus_passage(path: str, start: int, end: int) -> dict:
    cfg = config_store.load(CONFIG_PATH)
    from pipeline import ingest

    content = ingest.read_passage(Path(cfg.project.corpus_path), path, start, end)
    return {"path": path, "line_start": start, "line_end": end, "content": content}


@app.post("/api/corpus/ingest", response_model=IngestStatus)
def corpus_ingest_start() -> IngestStatus:
    cfg = config_store.load(CONFIG_PATH)
    from pipeline import ingest

    return ingest.start_ingest_task(cfg)


@app.get("/api/corpus/ingest/status", response_model=IngestStatus)
def corpus_ingest_status() -> IngestStatus:
    from pipeline import ingest

    return ingest.get_ingest_status()


# ---------------------------------------------------------------------------
# Seed authoring
# ---------------------------------------------------------------------------


@app.post("/api/seed/validate", response_model=SeedValidateResponse)
def seed_validate(req: SeedValidateRequest) -> SeedValidateResponse:
    cfg = config_store.load(CONFIG_PATH)
    return seed_store.validate(cfg, req)


@app.post("/api/seed/save", response_model=SeedSaveResponse)
def seed_save(req: SeedSaveRequest) -> SeedSaveResponse:
    cfg = config_store.load(CONFIG_PATH)
    try:
        return seed_store.save(cfg, req)
    except seed_store.DuplicateQuestionError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "duplicate_question", "message": str(e), "existing_id": e.existing_id},
        ) from e


@app.get("/api/seed/list", response_model=SeedListResponse)
def seed_list() -> SeedListResponse:
    cfg = config_store.load(CONFIG_PATH)
    return seed_store.list_cases(cfg)


@app.get("/api/seed/drafts")
def seed_list_drafts() -> list[dict]:
    return seed_store.list_drafts(PROJECT_ROOT)


@app.put("/api/seed/drafts/{draft_id}")
def seed_save_draft(draft_id: str, draft: dict) -> dict:
    return seed_store.save_draft(PROJECT_ROOT, draft_id, draft)


@app.delete("/api/seed/drafts/{draft_id}")
def seed_delete_draft(draft_id: str) -> JSONResponse:
    seed_store.delete_draft(PROJECT_ROOT, draft_id)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


@app.on_event("startup")
def on_startup() -> None:
    logger.info("RAG Refiner API starting at %s", PROJECT_ROOT)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
