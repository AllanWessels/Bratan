"""Disk-backed LLM response cache.

Why this exists
---------------
Identical `(model, prompt, temperature)` triples appear all the time across re-runs:
- the judge re-grades the same case after a no-op pipeline change,
- drift_check re-grades historical pairs,
- subset-eval loops over the same near-threshold cases.

Caching makes those near-free. Cache misses still touch the network.

Key shape
---------
sha256(f"{model}|{prompt}|{temperature:.6f}") -> hex digest.
Files land under `<project_root>/.cache/llm/<first-2-hex-chars>/<full-hash>.json`.
Atomic writes via `tempfile + os.replace` so a crash mid-write can't corrupt entries.

Public surface
--------------
- `cached_call(caller, model, prompt, temperature, ttl_hours)` — the wrapper.
  Returns `(text, tokens_in, tokens_out, cache_hit)`.
- `CACHE_STATS` — module-level counters (`hits` / `misses`) for the current process.
- `clear_cache()` — wipes the cache dir; test-only.

Callers opt in explicitly — no monkey-patching, no decorators that take effect on
import. `pipeline.judge` and `pipeline.query` import this module and wrap their
own `_call_anthropic` / `_call_vllm` helpers via `cached_call`.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import tempfile
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CACHE_ROOT_ENV = "BRATAN_LLM_CACHE_DIR"

CACHE_STATS: dict[str, int] = {"hits": 0, "misses": 0}
_STATS_LOCK = threading.Lock()


def _cache_root() -> Path:
    """Resolve the cache directory; honour the env var so tests can sandbox it."""
    override = os.environ.get(CACHE_ROOT_ENV)
    if override:
        return Path(override)
    return PROJECT_ROOT / ".cache" / "llm"


def _hash_key(model: str, prompt: str, temperature: float) -> str:
    payload = f"{model}|{prompt}|{temperature:.6f}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _entry_path(key: str) -> Path:
    return _cache_root() / key[:2] / f"{key}.json"


def reset_stats() -> None:
    """Reset hit/miss counters — call once at the start of a run."""
    with _STATS_LOCK:
        CACHE_STATS["hits"] = 0
        CACHE_STATS["misses"] = 0


def _record(hit: bool) -> None:
    with _STATS_LOCK:
        CACHE_STATS["hits" if hit else "misses"] += 1


def _read_entry(path: Path, ttl_hours: float) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not read cache entry %s: %s", path, exc)
        return None

    stored_at_raw = payload.get("stored_at")
    if not isinstance(stored_at_raw, str):
        return None
    try:
        stored_at = datetime.fromisoformat(stored_at_raw)
    except ValueError:
        return None
    if stored_at.tzinfo is None:
        stored_at = stored_at.replace(tzinfo=UTC)

    if ttl_hours > 0:
        if datetime.now(UTC) - stored_at > timedelta(hours=ttl_hours):
            return None

    return payload


def _write_entry_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def cached_call(
    caller: Callable[..., tuple[str, int, int]],
    model: str,
    prompt: str,
    temperature: float,
    ttl_hours: float,
    *caller_args: Any,
    **caller_kwargs: Any,
) -> tuple[str, int, int, bool]:
    """Run `caller(*caller_args, **caller_kwargs)` with disk-backed memoization.

    The cache key derives from `(model, prompt, temperature)` only — the caller's
    own arguments must produce a deterministic answer for the same triple, which
    is how the LLM endpoints are configured (`temperature=0`).

    Returns `(text, tokens_in, tokens_out, cache_hit)`.
    """
    key = _hash_key(model, prompt, temperature)
    path = _entry_path(key)

    cached = _read_entry(path, ttl_hours)
    if cached is not None:
        _record(hit=True)
        text = str(cached.get("text", ""))
        tokens_in = int(cached.get("tokens_in", 0) or 0)
        tokens_out = int(cached.get("tokens_out", 0) or 0)
        return text, tokens_in, tokens_out, True

    _record(hit=False)
    text, tokens_in, tokens_out = caller(*caller_args, **caller_kwargs)

    payload = {
        "text": text,
        "tokens_in": int(tokens_in),
        "tokens_out": int(tokens_out),
        "stored_at": datetime.now(UTC).isoformat(),
        "model": model,
    }
    try:
        _write_entry_atomic(path, payload)
    except OSError as exc:
        logger.warning("Could not persist cache entry for %s: %s", model, exc)

    return text, tokens_in, tokens_out, False


def clear_cache() -> None:
    """Wipe the cache directory. Test-only — production should never call this."""
    import shutil

    root = _cache_root()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
