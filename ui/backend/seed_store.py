"""Seed-case persistence and validation.

Finalized cases live in `test_cases/seed.jsonl` (append-only). In-flight UI
drafts live in `test_cases/.drafts/*.json` and are mutable; saving a case
deletes the originating draft.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ui.backend.schemas import (
    BratanConfig,
    Passage,
    PassageRef,
    SeedCase,
    SeedListResponse,
    SeedSaveRequest,
    SeedSaveResponse,
    SeedValidateRequest,
    SeedValidateResponse,
)

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(os.environ.get("BRATAN_PROJECT_ROOT", Path(__file__).resolve().parents[2]))
SEED_PATH = _PROJECT_ROOT / "test_cases" / "seed.jsonl"
DRAFTS_DIR = _PROJECT_ROOT / "test_cases" / ".drafts"

_WRITE_LOCK = threading.Lock()


class DuplicateQuestionError(Exception):
    """Raised when a question already exists in `seed.jsonl`."""

    def __init__(self, message: str, existing_id: str) -> None:
        super().__init__(message)
        self.existing_id = existing_id


# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------


def validate(cfg: BratanConfig, req: SeedValidateRequest) -> SeedValidateResponse:
    warnings: list[str] = []

    # (1) Retrieval check: can the pipeline's vector search find the chosen passages?
    passages_in_top_k = False
    top_k_match_count = 0
    top_k_searched = 5
    try:
        from pipeline.embeddings import get_embedder
        from pipeline.factories import get_vectordb

        embedder = get_embedder(cfg.models.embedding_model)
        adapter = get_vectordb(cfg)
        if adapter.count() == 0:
            warnings.append("Vector store is empty — run ingest before validating.")
        else:
            embedding = embedder.embed_query(req.question)
            hits = adapter.vector_query(embedding, k=top_k_searched)
            for ref in req.passages:
                if _passage_overlaps_any_hit(ref, hits):
                    top_k_match_count += 1
            passages_in_top_k = top_k_match_count > 0
    except Exception as exc:
        logger.warning("Retrieval check failed: %s", exc)
        warnings.append(f"Retrieval check skipped: {exc}")

    # (2) Answer-text check: does ground truth appear in the chosen passages?
    answer_text_in_passages = False
    try:
        from pipeline import ingest

        corpus_path = Path(cfg.project.corpus_path)
        haystack_parts: list[str] = []
        for ref in req.passages:
            try:
                haystack_parts.append(
                    ingest.read_passage(corpus_path, ref.path, ref.line_start, ref.line_end)
                )
            except Exception as exc:
                warnings.append(f"Could not read {ref.path}:{ref.line_start}-{ref.line_end}: {exc}")
        haystack = _normalize(" ".join(haystack_parts))
        needle = _normalize(req.ground_truth)
        answer_text_in_passages = bool(needle) and needle in haystack
    except Exception as exc:
        logger.warning("Answer-text check failed: %s", exc)
        warnings.append(f"Answer-text check skipped: {exc}")

    # (3) Optional: run the current pipeline and score with a cheap substring rule.
    pipeline_answer: str | None = None
    pipeline_retrieved: list[Passage] | None = None
    pipeline_score: float | None = None
    if req.run_pipeline:
        try:
            from pipeline import query as pipeline_query

            result = pipeline_query.answer(cfg, req.question)
            pipeline_answer = result.get("answer")
            pipeline_retrieved = result.get("retrieved")
            if pipeline_answer:
                needle = _normalize(req.ground_truth)
                pipeline_score = (
                    1.0 if needle and needle in _normalize(pipeline_answer) else 0.0
                )
        except Exception as exc:
            logger.warning("Pipeline run failed: %s", exc)
            warnings.append(f"Pipeline run failed: {exc}")

    return SeedValidateResponse(
        passages_in_top_k=passages_in_top_k,
        answer_text_in_passages=answer_text_in_passages,
        top_k_match_count=top_k_match_count,
        top_k_searched=top_k_searched,
        pipeline_score=pipeline_score,
        pipeline_answer=pipeline_answer,
        pipeline_retrieved=pipeline_retrieved,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Save / list
# ---------------------------------------------------------------------------


def save(cfg: BratanConfig, req: SeedSaveRequest) -> SeedSaveResponse:
    case_id = _question_id(req.question)
    with _WRITE_LOCK:
        existing = _read_all_cases()
        for case in existing:
            if case.id == case_id:
                raise DuplicateQuestionError(
                    f"Question already saved (id={case_id})", existing_id=case_id
                )
        case = SeedCase(
            id=case_id,
            question=req.question,
            ground_truth=req.ground_truth,
            source_passages=req.passages,
            failure_category=req.failure_category,
            notes=req.notes,
            created_at=datetime.now(UTC),
            created_by="human",
        )
        _append_case(case)
        if req.draft_id:
            _delete_draft_file(req.draft_id)

    total = len(existing) + 1
    target = cfg.project.seed_target_n
    return SeedSaveResponse(ok=True, case=case, total_cases=total, target_n=target)


def list_cases(cfg: BratanConfig) -> SeedListResponse:
    cases = _read_all_cases()
    target = cfg.project.seed_target_n
    progress = min(1.0, len(cases) / target) if target > 0 else 0.0
    return SeedListResponse(cases=cases, target_n=target, progress=progress)


# ---------------------------------------------------------------------------
# Drafts (mutable scratch space; one JSON file per draft id)
# ---------------------------------------------------------------------------


def list_drafts(project_root: Path) -> list[dict[str, Any]]:
    drafts_dir = _drafts_dir(project_root)
    if not drafts_dir.exists():
        return []
    out: list[dict[str, Any]] = []
    for fp in sorted(drafts_dir.glob("*.json")):
        try:
            out.append(json.loads(fp.read_text(encoding="utf-8")))
        except Exception as exc:
            logger.warning("Could not parse draft %s: %s", fp, exc)
    return out


def save_draft(project_root: Path, draft_id: str, draft: dict[str, Any]) -> dict[str, Any]:
    drafts_dir = _drafts_dir(project_root)
    drafts_dir.mkdir(parents=True, exist_ok=True)
    payload = dict(draft)
    payload.setdefault("id", draft_id)
    payload["updated_at"] = datetime.now(UTC).isoformat()
    payload.setdefault("created_at", payload["updated_at"])
    _atomic_write(drafts_dir / f"{_sanitize(draft_id)}.json", json.dumps(payload, indent=2))
    return payload


def delete_draft(project_root: Path, draft_id: str) -> None:
    drafts_dir = _drafts_dir(project_root)
    target = drafts_dir / f"{_sanitize(draft_id)}.json"
    if target.exists():
        target.unlink()


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _read_all_cases() -> list[SeedCase]:
    if not SEED_PATH.exists():
        return []
    out: list[SeedCase] = []
    for line in SEED_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            out.append(_seed_case_from_raw(obj))
        except Exception as exc:
            logger.warning("Skipping malformed seed row: %s", exc)
    return out


def _seed_case_from_raw(obj: dict[str, Any]) -> SeedCase:
    """Accept rows in the canonical schema.md shape; tolerate older shapes for forward compat."""
    if "passages" in obj and "source_passages" not in obj:
        obj = dict(obj)
        obj["source_passages"] = [
            {
                "path": p.get("path", ""),
                "line_start": p.get("line_start", p.get("start_line", 1)),
                "line_end": p.get("line_end", p.get("end_line", 1)),
            }
            for p in obj.pop("passages") or []
        ]
    else:
        if obj.get("source_passages"):
            obj = dict(obj)
            obj["source_passages"] = [
                {
                    "path": p.get("path", ""),
                    "line_start": p.get("line_start", p.get("start_line", 1)),
                    "line_end": p.get("line_end", p.get("end_line", 1)),
                }
                for p in obj["source_passages"]
            ]
    if "source" in obj and "created_by" not in obj:
        s = obj.pop("source")
        obj["created_by"] = "red-team" if s == "red_team" else "human"
    return SeedCase.model_validate(obj)


def _append_case(case: SeedCase) -> None:
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    row = case.model_dump(mode="json")
    serialized = json.dumps(row, ensure_ascii=False)
    with SEED_PATH.open("a", encoding="utf-8") as f:
        f.write(serialized + "\n")


def _passage_overlaps_any_hit(ref: PassageRef, hits) -> bool:
    for hit in hits:
        meta = hit.metadata or {}
        if meta.get("path") != ref.path:
            continue
        start = int(meta.get("start_line", 0))
        end = int(meta.get("end_line", 0))
        if start == 0 and end == 0:
            continue
        # any line-range overlap counts; chunk metadata uses start_line/end_line (storage detail),
        # case refs use line_start/line_end (per test_cases/schema.md)
        if not (end < ref.line_start or start > ref.line_end):
            return True
    return False


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip().lower()


def _question_id(question: str) -> str:
    norm = _normalize(question)
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]


def _drafts_dir(project_root: Path) -> Path:
    return project_root / "test_cases" / ".drafts"


def _delete_draft_file(draft_id: str) -> None:
    target = DRAFTS_DIR / f"{_sanitize(draft_id)}.json"
    if target.exists():
        try:
            target.unlink()
        except OSError as exc:
            logger.warning("Could not delete draft %s: %s", target, exc)


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:128]


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
