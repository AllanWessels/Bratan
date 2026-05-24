"""Subprocess entry point for *reading* the vector store.

Why this exists
---------------
ChromaDB's Rust bindings hold *process-level* state per persistent path.
Once the long-running uvicorn backend has touched a `.chroma` path, that
in-memory client cannot be invalidated when the on-disk schema is wiped
or partially migrated under it — subsequent reads then surface as
"no such table: tenants", "no such table: databases", "Nothing found on
disk", or silent dimension mismatches every time the user clicks
"Search the corpus" or "Validate" in the seed wizard.

The structural fix is to never let the uvicorn process touch chromadb's
read API directly either. `scripts.ingest_worker` already isolates the
write path; this worker mirrors it for reads.

Protocol
--------
One operation per invocation. The parent writes a single JSON request to
stdin and reads a single JSON response from stdout. Exit code 0 means
the response object is populated and trustworthy; exit code 1 means the
worker hit a hard failure and the response contains an ``error`` field.

Request shapes (one per call)::

    # Form A — point at a full BratanConfig; the factory picks the adapter.
    {"op": "vector_query",
     "config_path": "/path/to/bratan.config.yaml",
     "embedding": [0.123, ...],
     "k": 10}

    # Form B — direct chroma kwargs; skips BratanConfig loading. Used by
    # ChromaAdapter's own subprocess-routing path (which doesn't have the
    # config in hand, only its own constructor args).
    {"op": "vector_query",
     "chroma_path": "/abs/.chroma",
     "chroma_collection": "corpus",
     "embedding": [0.123, ...],
     "k": 10}

    {"op": "count",
     "config_path": "/path/to/bratan.config.yaml"}

    {"op": "count",
     "chroma_path": "/abs/.chroma",
     "chroma_collection": "corpus"}

Response shapes::

    {"ok": true, "hits": [{"id": ..., "text": ..., "score": ...,
                           "metadata": {...}}, ...]}
    {"ok": true, "count": 1234}
    {"ok": false, "error": "..."}

The worker imports `pipeline.adapters.chroma.ChromaAdapter` directly
(NOT through the subprocess-routing flag) so the call hits the real
in-process chromadb client inside this fresh, un-poisoned process.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


def _build_adapter(req: dict[str, Any]):
    """Construct the vector adapter inside this fresh process.

    Two forms supported:

    1. ``config_path`` — load BratanConfig and dispatch through
       `pipeline.factories.get_vectordb`. Lets non-chroma adapters use the
       same isolation path for free.
    2. ``chroma_path`` (+ optional ``chroma_collection``) — construct
       ``ChromaAdapter`` directly. Used by ChromaAdapter's own subprocess
       routing, which has the path/collection in hand and doesn't need to
       reload BratanConfig from disk.

    The `BRATAN_CHROMA_SUBPROCESS_QUERY` env var is explicitly scrubbed in
    this child so we never recursively re-spawn ourselves.
    """
    import os

    # Belt-and-braces: even though our parent should not have leaked the
    # flag into our env, scrub it to guarantee we never recurse.
    os.environ.pop("BRATAN_CHROMA_SUBPROCESS_QUERY", None)

    if req.get("chroma_path"):
        from pipeline.adapters.chroma import ChromaAdapter

        return ChromaAdapter(
            path=Path(req["chroma_path"]),
            collection=req.get("chroma_collection", "corpus"),
            subprocess_query=False,
        )

    config_path = req.get("config_path")
    if not config_path:
        raise ValueError(
            "request must include either 'config_path' or 'chroma_path'"
        )

    from pipeline.factories import get_vectordb
    from ui.backend.config_store import load as load_config

    cfg = load_config(Path(config_path))
    return get_vectordb(cfg)


def _op_vector_query(req: dict[str, Any]) -> dict[str, Any]:
    embedding = req.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        return {"ok": False, "error": "vector_query requires non-empty 'embedding' list"}
    k = int(req.get("k", 10))
    adapter = _build_adapter(req)
    hits = adapter.vector_query(embedding, k)
    return {
        "ok": True,
        "hits": [
            {
                "id": h.id,
                "text": h.text,
                "score": h.score,
                "metadata": h.metadata,
            }
            for h in hits
        ],
    }


def _op_count(req: dict[str, Any]) -> dict[str, Any]:
    adapter = _build_adapter(req)
    return {"ok": True, "count": int(adapter.count())}


_OPS = {
    "vector_query": _op_vector_query,
    "count": _op_count,
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="One-shot subprocess query against the configured vector store."
    )
    # No args required — request comes over stdin. We keep argparse for the
    # --help text and so future flags (e.g. --timeout) can be added without
    # breaking the invocation contract.
    return parser.parse_args(argv)


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty stdin: expected a JSON request object")
    return json.loads(raw)


def _write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def run() -> int:
    logging.basicConfig(
        level=logging.WARNING,
        # Logs go to stderr by default so they don't corrupt the stdout
        # JSON response the parent is parsing.
        format="%(asctime)s %(levelname)s [query-worker] %(message)s",
    )
    try:
        req = _read_request()
    except Exception as exc:
        _write_response({"ok": False, "error": f"invalid request: {exc}"})
        return 1

    op_name = req.get("op")
    if op_name not in _OPS:
        _write_response(
            {"ok": False, "error": f"unknown op {op_name!r}; expected one of {sorted(_OPS)}"}
        )
        return 1

    try:
        result = _OPS[op_name](req)
    except Exception as exc:
        err = "".join(traceback.format_exception_only(type(exc), exc)).strip() or str(exc)
        logger.exception("query-worker op %s failed", op_name)
        _write_response({"ok": False, "error": err})
        return 1

    _write_response(result)
    return 0 if result.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    _parse_args(argv)
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
