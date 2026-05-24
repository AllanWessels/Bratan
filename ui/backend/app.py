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
import shutil
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ui.backend import config_store, loop_control, seed_store, system_probe, vllm_control
from ui.backend.schemas import (
    BratanConfig,
    ConnectionTest,
    CorpusFile,
    CorpusPassagesResponse,
    CorpusSearchRequest,
    CorpusSearchResponse,
    GeneratedFileSummary,
    IngestStatus,
    LoopStartRequest,
    LoopStartResponse,
    LoopStatus,
    LoopStopResponse,
    ProbeResult,
    ReportSummary,
    SaveStepRequest,
    SaveStepResponse,
    SeedCase,
    SeedListResponse,
    SeedSaveRequest,
    SeedSaveResponse,
    SeedValidateRequest,
    SeedValidateResponse,
    SetupState,
    SystemResetResponse,
    TestAnthropicRequest,
    TestVectorDBRequest,
    TestVLLMRequest,
    VLLMStartRequest,
    VLLMStatus,
    VLLMStopResponse,
)
from ui.backend.schemas import VectorDBAdapter as schemas_VectorDBAdapter

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(os.environ.get("BRATAN_PROJECT_ROOT", Path(__file__).resolve().parents[2]))
CONFIG_PATH = PROJECT_ROOT / "bratan.config.yaml"

app = FastAPI(
    title="Bratan",
    version="0.1.0",
    description="Bratan — a self-improving RAG pipeline driven by red-team / blue-team / judge agents.",
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


@app.get("/api/corpus/passages", response_model=CorpusPassagesResponse)
def corpus_passages(path: str, offset: int = 0, limit: int = 20) -> CorpusPassagesResponse:
    """List a page of fixed-line-window passages from a single corpus file.

    Backs the SME "browse the corpus" authoring flow. Unlike
    ``/api/corpus/passage`` (single arbitrary range) and
    ``/api/corpus/search`` (vector retrieval), this endpoint walks the raw
    file in ``PASSAGE_WINDOW_LINES``-line windows so subject-matter experts
    can read the document the way the author wrote it and pick a passage
    that ought to support a question.
    """
    cfg = config_store.load(CONFIG_PATH)
    from pipeline import ingest

    # Clamp limit to 50 server-side too — the helper does it again but it's
    # cheap and makes the contract obvious.
    limit = max(1, min(50, int(limit)))
    offset = max(0, int(offset))

    try:
        passages, total = ingest.list_passages_paginated(
            Path(cfg.project.corpus_path), path, offset=offset, limit=limit
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="file_not_found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=400, detail="path_escapes_corpus") from exc
    return CorpusPassagesResponse(
        passages=passages,  # type: ignore[arg-type]
        total=total,
        offset=offset,
        limit=limit,
        window_lines=ingest.PASSAGE_WINDOW_LINES,
    )


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
# Red-team generated cases — read-only browsing of test_cases/generated/.
# The append-only invariant means there's deliberately no edit/delete here.
# ---------------------------------------------------------------------------


@app.get("/api/seed/generated", response_model=list[GeneratedFileSummary])
def seed_generated_files() -> list[GeneratedFileSummary]:
    return seed_store.list_generated_files(PROJECT_ROOT)


@app.get("/api/seed/generated/{timestamp}", response_model=list[SeedCase])
def seed_generated_cases(timestamp: str) -> list[SeedCase]:
    try:
        return seed_store.read_generated_file(PROJECT_ROOT, timestamp)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="generated_file_not_found") from exc


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
# Managed vLLM lifecycle (M2.5 — "I want it on, start it for me")
# ---------------------------------------------------------------------------


@app.post("/api/system/vllm/start", response_model=VLLMStatus)
def system_vllm_start(req: VLLMStartRequest) -> VLLMStatus:
    try:
        vllm_control.start(PROJECT_ROOT, model=req.model, port=req.port)
    except vllm_control.VLLMNotInstalledError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "vllm_not_installed",
                "message": str(exc),
                "hint": "uv sync --extra gpu",
            },
        ) from exc
    except RuntimeError as exc:
        if str(exc) == "vllm_already_running":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"error": "vllm_already_running"},
            ) from exc
        raise
    return VLLMStatus(**vllm_control.status())


@app.post("/api/system/vllm/stop", response_model=VLLMStopResponse)
def system_vllm_stop() -> VLLMStopResponse:
    return VLLMStopResponse(**vllm_control.stop())


@app.get("/api/system/vllm/status", response_model=VLLMStatus)
def system_vllm_status() -> VLLMStatus:
    return VLLMStatus(**vllm_control.status())


# ---------------------------------------------------------------------------
# Vector-store reset — wipes `.chroma/` AND drops in-process chroma client
# refs so verifier agents and end users can recover from a poisoned state
# without manual `rm -rf` and without bouncing uvicorn.
#
# The endpoint deliberately does NOT touch /corpus/, /test_cases/seed.jsonl,
# or /reports/ — those are anchors that the loop's regression guarantees
# depend on. The reset is scoped to the vector store ONLY.
# ---------------------------------------------------------------------------


@app.post("/api/system/reset-vector-store", response_model=SystemResetResponse)
def system_reset_vector_store(
    confirm: bool = False,
    body: dict | None = Body(default=None),
) -> SystemResetResponse:
    """Wipe the configured `.chroma/` directory + drop in-process chroma refs.

    Guarded: the caller must pass either `?confirm=true` as a query param OR a
    JSON body of ``{"confirm": true}`` so accidental curl hits do nothing.

    Only supported for the chroma adapter; for managed stores
    (Qdrant/Pinecone/Weaviate/pgvector) the user must reset via the provider's
    console — we refuse with 400 rather than silently no-op.
    """
    confirmed = bool(confirm) or bool(isinstance(body, dict) and body.get("confirm") is True)
    if not confirmed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "confirmation_required",
                "message": (
                    "Vector-store reset is destructive. Pass ?confirm=true "
                    'or a JSON body {"confirm": true} to proceed.'
                ),
            },
        )

    cfg = config_store.load(CONFIG_PATH)
    adapter = cfg.vector_db.adapter
    if adapter != schemas_VectorDBAdapter.CHROMA:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "adapter_not_supported",
                "message": (
                    f"Reset is only supported for the chroma adapter; "
                    f"current adapter is {adapter.value!r}. For Qdrant, "
                    f"Pinecone, Weaviate, or pgvector, use your provider's "
                    f"console (or DROP TABLE for pgvector) to clear the store."
                ),
            },
        )

    # Resolve chroma_path: relative paths are anchored at PROJECT_ROOT so
    # different working directories don't accidentally point at the wrong
    # `.chroma` dir on disk.
    chroma_path_raw = cfg.vector_db.chroma_path or "./.chroma"
    chroma_path = Path(chroma_path_raw)
    if not chroma_path.is_absolute():
        chroma_path = (PROJECT_ROOT / chroma_path).resolve()

    # Safety belt: never let the path escape PROJECT_ROOT. If the user
    # configured `chroma_path: /` we refuse rather than `rm -rf /`.
    try:
        chroma_path.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "path_outside_project",
                "message": (
                    f"Refusing to reset {chroma_path!s}: it escapes the "
                    f"project root {PROJECT_ROOT!s}."
                ),
            },
        ) from exc

    # Belt-and-braces: never let the resolved path land on a sibling we
    # protect (corpus / test_cases / reports). The relative_to check above
    # already prevents this for properly-configured paths, but a `chroma_path:
    # ./corpus` would slip through it.
    protected = {
        (PROJECT_ROOT / "corpus").resolve(),
        (PROJECT_ROOT / "test_cases").resolve(),
        (PROJECT_ROOT / "reports").resolve(),
    }
    if chroma_path.resolve() in protected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "path_is_protected",
                "message": (
                    f"Refusing to reset {chroma_path!s}: it overlaps a "
                    f"protected directory (corpus / test_cases / reports)."
                ),
            },
        )

    # Drop in-process refs FIRST so no live client is holding the sqlite
    # handle when we rmtree the directory under it.
    from pipeline.adapters import chroma as chroma_adapter_mod

    # NOTE: drop_in_process_clients() returns True only if it actually
    # cleared something; we want client_dropped to mean "the cleanup step
    # ran cleanly" regardless of whether any client was registered. The
    # frontend uses this field as a confirmation that the drop path
    # executed without error, not as a count of cleared handles.
    chroma_adapter_mod.drop_in_process_clients()
    client_dropped = True

    path_wiped: str | None = None
    if chroma_path.exists():
        shutil.rmtree(chroma_path, ignore_errors=True)
        path_wiped = str(chroma_path)
        logger.info("Wiped vector store at %s", chroma_path)
    else:
        logger.info("Vector store path %s did not exist; nothing to wipe", chroma_path)

    return SystemResetResponse(
        ok=True,
        path_wiped=path_wiped,
        client_dropped=client_dropped,
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


@app.on_event("startup")
def on_startup() -> None:
    logger.info("Bratan API starting at %s", PROJECT_ROOT)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Route every chromadb READ this process makes through a fresh subprocess
    # (`scripts.query_worker`). The long-running uvicorn host previously kept
    # chromadb's per-path Rust singleton in memory; once `.chroma/` was wiped
    # or partially migrated under it, every subsequent `/api/corpus/search`
    # and `/api/seed/validate` surfaced "no such table: tenants/databases" /
    # "Nothing found on disk" / dimension-mismatch errors. The subprocess
    # routing isolates that state to a short-lived child that can't outlive
    # a single request. Writes already go through `scripts.ingest_worker`.
    os.environ.setdefault("BRATAN_CHROMA_SUBPROCESS_QUERY", "1")
