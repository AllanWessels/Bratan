"""FastAPI app — setup wizard + corpus + seed-authoring endpoints.

This file defines the route signatures only. Each route delegates to a service module
that the backend agent fills in. The signatures are the wire contract.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ui.backend import config_store, loop_control, seed_store, system_probe
from ui.backend.schemas import (
    BratanConfig,
    ConnectionTest,
    CorpusFile,
    CorpusSearchRequest,
    CorpusSearchResponse,
    IngestStatus,
    LoopStartRequest,
    LoopStartResponse,
    LoopStatus,
    LoopStopResponse,
    ProbeResult,
    ReportSummary,
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
# Reports (M2 dashboard read-side)
# ---------------------------------------------------------------------------


REPORTS_DIR = PROJECT_ROOT / "reports"


def _list_history_files() -> list[Path]:
    history = REPORTS_DIR / "history"
    if not history.exists():
        return []
    return sorted(history.glob("run-*.json"))


def _load_report_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/reports/latest")
def reports_latest() -> dict:
    latest = REPORTS_DIR / "latest.json"
    if not latest.exists():
        raise HTTPException(status_code=404, detail="no_reports_yet")
    return _load_report_file(latest)


@app.get("/api/reports/history", response_model=list[ReportSummary])
def reports_history() -> list[ReportSummary]:
    summaries: list[ReportSummary] = []
    for path in _list_history_files():
        try:
            payload = _load_report_file(path)
        except Exception as exc:  # corrupt file — skip but log
            logger.warning("could not load history file %s: %s", path.name, exc)
            continue
        summaries.append(
            ReportSummary(
                timestamp=payload.get("timestamp", ""),
                iteration=int(payload.get("iteration", 0)),
                composite_mean=float(payload.get("composite_mean", 0.0)),
                pass_rate_at_0_6=float(payload.get("pass_rate_at_0_6", 0.0)),
                stop_reason=payload.get("stop_reason"),
            )
        )
    # Newest first.
    summaries.sort(key=lambda s: s.timestamp, reverse=True)
    return summaries


@app.get("/api/reports/{timestamp}")
def reports_by_timestamp(timestamp: str) -> dict:
    # The stored filename normalizes ":" and "." in the ISO timestamp. Accept either form.
    candidates = {
        timestamp,
        timestamp.replace(":", "-").replace(".", "-"),
    }
    for path in _list_history_files():
        try:
            payload = _load_report_file(path)
        except Exception:
            continue
        if payload.get("timestamp") in candidates or path.stem.removeprefix("run-") in candidates:
            return payload
    raise HTTPException(status_code=404, detail="report_not_found")


# ---------------------------------------------------------------------------
# Loop control (M2)
# ---------------------------------------------------------------------------


@app.post("/api/loop/start", response_model=LoopStartResponse)
def loop_start(req: LoopStartRequest) -> LoopStartResponse:
    try:
        resp = loop_control.start(
            PROJECT_ROOT,
            iterations=req.iterations,
            budget_usd=req.budget_usd,
            skip_red=req.skip_red,
            no_agents=req.no_agents,
        )
    except RuntimeError as exc:
        if str(exc) == "loop_already_running":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": "loop_already_running"},
            ) from exc
        raise
    return LoopStartResponse(**resp)


@app.post("/api/loop/stop", response_model=LoopStopResponse)
def loop_stop() -> LoopStopResponse:
    return LoopStopResponse(**loop_control.stop())


@app.get("/api/loop/status", response_model=LoopStatus)
def loop_status() -> LoopStatus:
    return LoopStatus(**loop_control.status(PROJECT_ROOT))


@app.websocket("/api/loop/stream")
async def loop_stream(ws: WebSocket) -> None:
    """Broadcast per-iteration events by polling /reports/latest.json mtime.

    Push a starter "iteration_complete" event with the current latest report (if any),
    then whenever the mtime changes (a new iteration finished writing) push the new
    payload. If the loop process exits without a new report, push "loop_stopped".
    """
    await ws.accept()

    last_mtime = loop_control.latest_report_mtime(PROJECT_ROOT)
    # Send an initial snapshot so the client doesn't have to round-trip the REST endpoint.
    initial = loop_control.read_latest_report(PROJECT_ROOT)
    if initial is not None:
        await ws.send_text(
            json.dumps(
                {
                    "type": "iteration_complete",
                    "report": initial,
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            )
        )

    was_running = loop_control.is_running()
    try:
        while True:
            await asyncio.sleep(0.5)
            mtime = loop_control.latest_report_mtime(PROJECT_ROOT)
            if mtime is not None and mtime != last_mtime:
                last_mtime = mtime
                payload = loop_control.read_latest_report(PROJECT_ROOT)
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "iteration_complete",
                            "report": payload,
                            "timestamp": datetime.now(UTC).isoformat(),
                        }
                    )
                )
            running = loop_control.is_running()
            if was_running and not running:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "loop_stopped",
                            "report": None,
                            "timestamp": datetime.now(UTC).isoformat(),
                        }
                    )
                )
            was_running = running
    except WebSocketDisconnect:
        return
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("loop_stream error: %s", exc)
        with contextlib.suppress(Exception):
            await ws.send_text(
                json.dumps(
                    {
                        "type": "error",
                        "report": None,
                        "timestamp": datetime.now(UTC).isoformat(),
                    }
                )
            )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


@app.on_event("startup")
def on_startup() -> None:
    logger.info("RAG Refiner API starting at %s", PROJECT_ROOT)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
