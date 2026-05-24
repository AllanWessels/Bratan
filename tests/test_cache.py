"""Unit tests for pipeline.cache — the disk-backed LLM response cache."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from pipeline import cache as cache_mod


def _const_caller(text: str = "ok", ti: int = 7, to: int = 3):
    """Return a callable that records its invocation count + returns canned output."""

    state = {"calls": 0}

    def _call(*_args, **_kwargs) -> tuple[str, int, int]:
        state["calls"] += 1
        return text, ti, to

    _call.state = state  # type: ignore[attr-defined]
    return _call


def test_first_call_is_miss_persists_to_disk(tmp_path: Path) -> None:
    caller = _const_caller("first answer", 100, 50)

    text, ti, to, hit = cache_mod.cached_call(
        caller, "model-a", "prompt-a", 0.0, ttl_hours=24
    )

    assert (text, ti, to, hit) == ("first answer", 100, 50, False)
    assert caller.state["calls"] == 1
    # Entry exists on disk under the sharded path.
    key = cache_mod._hash_key("model-a", "prompt-a", 0.0)
    entry = cache_mod._entry_path(key)
    assert entry.exists()
    payload = json.loads(entry.read_text(encoding="utf-8"))
    assert payload["text"] == "first answer"
    assert payload["tokens_in"] == 100
    assert payload["tokens_out"] == 50
    assert payload["model"] == "model-a"
    assert "stored_at" in payload


def test_second_call_with_same_key_is_hit_skips_caller(tmp_path: Path) -> None:
    caller = _const_caller("cached!", 1, 2)

    cache_mod.cached_call(caller, "model-x", "prompt-x", 0.0, ttl_hours=24)
    text, ti, to, hit = cache_mod.cached_call(
        caller, "model-x", "prompt-x", 0.0, ttl_hours=24
    )

    assert (text, ti, to, hit) == ("cached!", 1, 2, True)
    assert caller.state["calls"] == 1  # second call short-circuited
    assert cache_mod.CACHE_STATS == {"hits": 1, "misses": 1}


def test_different_temperature_is_different_key(tmp_path: Path) -> None:
    caller = _const_caller("alpha")
    cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=24)
    cache_mod.cached_call(caller, "m", "p", 0.5, ttl_hours=24)
    assert caller.state["calls"] == 2  # two distinct cache buckets


def test_different_model_is_different_key(tmp_path: Path) -> None:
    caller = _const_caller("alpha")
    cache_mod.cached_call(caller, "m1", "p", 0.0, ttl_hours=24)
    cache_mod.cached_call(caller, "m2", "p", 0.0, ttl_hours=24)
    assert caller.state["calls"] == 2


def test_ttl_expiry_treats_old_entry_as_miss(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    caller = _const_caller("fresh")

    # Seed an expired entry by hand.
    key = cache_mod._hash_key("m", "p", 0.0)
    expired = {
        "text": "stale",
        "tokens_in": 1,
        "tokens_out": 1,
        "stored_at": (datetime.now(UTC) - timedelta(hours=48)).isoformat(),
        "model": "m",
    }
    path = cache_mod._entry_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(expired), encoding="utf-8")

    text, _ti, _to, hit = cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=1)

    assert hit is False
    assert text == "fresh"  # caller re-ran
    # Entry has been overwritten with a fresh stored_at.
    overwritten = json.loads(path.read_text(encoding="utf-8"))
    assert overwritten["text"] == "fresh"


def test_zero_ttl_is_treated_as_no_expiry(tmp_path: Path) -> None:
    """ttl_hours <= 0 means 'never expire' (matches read_entry semantics)."""
    caller = _const_caller("forever")
    cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=0)
    cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=0)
    # Both calls hit a never-expiring entry — second is a hit.
    assert caller.state["calls"] == 1


def test_atomic_write_no_tmp_leftovers(tmp_path: Path) -> None:
    caller = _const_caller("clean")
    cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=24)
    root = cache_mod._cache_root()
    leftovers = [p for p in root.rglob("*.tmp")]
    assert leftovers == []


def test_stats_increment_per_call(tmp_path: Path) -> None:
    caller = _const_caller()
    cache_mod.reset_stats()
    cache_mod.cached_call(caller, "m", "p1", 0.0, ttl_hours=24)
    cache_mod.cached_call(caller, "m", "p2", 0.0, ttl_hours=24)
    cache_mod.cached_call(caller, "m", "p1", 0.0, ttl_hours=24)  # hit
    assert cache_mod.CACHE_STATS == {"hits": 1, "misses": 2}


def test_corrupt_entry_treated_as_miss(tmp_path: Path) -> None:
    caller = _const_caller("rewritten")
    key = cache_mod._hash_key("m", "p", 0.0)
    path = cache_mod._entry_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not valid json", encoding="utf-8")

    text, _ti, _to, hit = cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=24)
    assert hit is False
    assert text == "rewritten"


def test_env_override_relocates_cache_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRATAN_LLM_CACHE_DIR", str(tmp_path / "custom"))
    caller = _const_caller()
    cache_mod.cached_call(caller, "m", "p", 0.0, ttl_hours=24)
    expected = tmp_path / "custom"
    assert any(expected.rglob("*.json"))
