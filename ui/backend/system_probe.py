"""System probes and connection tests for the setup wizard."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time

import httpx

from ui.backend.schemas import (
    BratanConfig,
    ConnectionTest,
    GPUInfo,
    ProbeResult,
    TestAnthropicRequest,
    TestVectorDBRequest,
    TestVLLMRequest,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Full probe
# ---------------------------------------------------------------------------


def run_full_probe() -> ProbeResult:
    gpu = _probe_gpu()
    vllm_url = os.environ.get("VLLM_BASE_URL", "http://localhost:8001")
    vllm_reachable = _ping_vllm(vllm_url, timeout=1.0)
    return ProbeResult(
        gpu=gpu,
        vllm_reachable=vllm_reachable,
        vllm_url=vllm_url,
        anthropic_key_set=bool(os.environ.get("ANTHROPIC_API_KEY")),
    )


def _probe_gpu() -> GPUInfo:
    if not shutil.which("nvidia-smi"):
        return GPUInfo(detected=False)
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )
    except (subprocess.SubprocessError, subprocess.TimeoutExpired) as exc:
        logger.warning("nvidia-smi failed: %s", exc)
        return GPUInfo(detected=False)

    line = (out.stdout or "").strip().splitlines()[:1]
    if not line:
        return GPUInfo(detected=False)
    parts = [p.strip() for p in line[0].split(",")]
    if len(parts) < 3:
        return GPUInfo(detected=False)
    try:
        return GPUInfo(
            detected=True,
            name=parts[0],
            vram_total_mb=int(float(parts[1])),
            vram_free_mb=int(float(parts[2])),
        )
    except ValueError as exc:
        logger.warning("Could not parse nvidia-smi output %r: %s", parts, exc)
        return GPUInfo(detected=False)


def _ping_vllm(base_url: str, timeout: float = 1.0) -> bool:
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/v1/models", timeout=timeout)
        return r.status_code < 500
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Per-service tests
# ---------------------------------------------------------------------------


def test_vectordb(req: TestVectorDBRequest) -> ConnectionTest:
    # Keep the request's adapter and the config's adapter aligned; the
    # wizard sometimes sends them separately and the factory dispatches off
    # the config field.
    cfg_data = req.config.model_dump()
    cfg_data["adapter"] = req.adapter
    cfg = BratanConfig(vector_db=cfg_data)
    t0 = time.perf_counter()
    try:
        from pipeline.factories import get_vectordb

        adapter = get_vectordb(cfg)
        result = adapter.health_check()
        if result.latency_ms is None:
            result = result.model_copy(update={"latency_ms": (time.perf_counter() - t0) * 1000.0})
        return result
    except Exception as exc:
        return ConnectionTest(ok=False, error=str(exc))


def test_anthropic(req: TestAnthropicRequest) -> ConnectionTest:
    if not req.api_key:
        return ConnectionTest(ok=False, error="No API key provided.")
    t0 = time.perf_counter()
    try:
        from anthropic import Anthropic

        # Hard 10s ceiling: an unreachable network or a paused API would
        # otherwise hang the wizard's "Test" button indefinitely.
        client = Anthropic(api_key=req.api_key, timeout=10.0, max_retries=0)
        resp = client.messages.create(
            model=req.model,
            max_tokens=1,
            messages=[{"role": "user", "content": "ping"}],
        )
        latency_ms = (time.perf_counter() - t0) * 1000.0
        return ConnectionTest(
            ok=True,
            latency_ms=latency_ms,
            detail={"model": req.model, "id": getattr(resp, "id", None)},
        )
    except Exception as exc:
        return ConnectionTest(ok=False, error=str(exc))


def test_vllm(req: TestVLLMRequest) -> ConnectionTest:
    url = f"{req.base_url.rstrip('/')}/v1/models"
    t0 = time.perf_counter()
    try:
        r = httpx.get(url, timeout=2.0)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        if r.status_code >= 400:
            return ConnectionTest(
                ok=False,
                latency_ms=latency_ms,
                error=f"HTTP {r.status_code}: {r.text[:200]}",
            )
        try:
            payload = r.json()
        except Exception:
            payload = {"raw": r.text[:200]}
        return ConnectionTest(ok=True, latency_ms=latency_ms, detail=payload)
    except Exception as exc:
        return ConnectionTest(ok=False, error=str(exc))
