"""End-to-end smoke for the seed-authoring workflow.

Runs against FastAPI TestClient with a tiny on-disk corpus. Skipped until the M1
backend agent finishes wiring the services.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import pytest


pytest.importorskip("ui.backend.app", reason="backend agent has not finished yet")
pytest.importorskip("pipeline.adapters.chroma", reason="backend agent has not finished yet")


@pytest.fixture
def project_tmp(monkeypatch: pytest.MonkeyPatch) -> Path:
    root = Path(tempfile.mkdtemp(prefix="bratan-it-"))
    (root / "corpus").mkdir()
    (root / "test_cases").mkdir()
    (root / ".chroma").mkdir()
    (root / "corpus" / "fox.md").write_text(
        "# Fox\n\nThe quick brown fox jumps over the lazy dog.\nFoxes are clever.\n",
    )
    monkeypatch.setenv("BRATAN_PROJECT_ROOT", str(root))
    yield root
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def client(project_tmp: Path):
    from fastapi.testclient import TestClient

    from ui.backend.app import app

    return TestClient(app)


def test_setup_state_when_empty(client) -> None:
    r = client.get("/api/setup/state")
    assert r.status_code == 200
    body = r.json()
    assert body["setup_completed"] is False
    assert body["total_steps"] == 8


def test_save_step_persists(client, project_tmp) -> None:
    r = client.post(
        "/api/setup/save-step",
        json={
            "step": 1,
            "data": {
                "project": {
                    "project_name": "test",
                    "corpus_path": str(project_tmp / "corpus"),
                    "seed_target_n": 20,
                }
            },
        },
    )
    assert r.status_code == 200, r.text
    cfg = r.json()["config"]
    assert cfg["project"]["seed_target_n"] == 20


@pytest.mark.skip(reason="requires GPU embedder; M1 functional acceptance, not CI smoke")
def test_seed_save_and_list(client, project_tmp) -> None:
    # Walk wizard to completion with defaults
    client.post("/api/setup/save-step", json={"step": 1, "data": {"project_name": "t", "corpus_path": str(project_tmp / "corpus")}})
    client.post("/api/setup/finish")
    # Ingest corpus
    r = client.post("/api/corpus/ingest")
    assert r.status_code == 200
    # Save a hand-built seed case (skip search step here)
    r = client.post(
        "/api/seed/save",
        json={
            "question": "What does the fox jump over?",
            "ground_truth": "the lazy dog",
            "passages": [{"path": "fox.md", "line_start": 3, "line_end": 3}],
            "failure_category": "paraphrase_brittleness",
        },
    )
    assert r.status_code == 200, r.text
    # List
    r = client.get("/api/seed/list")
    assert r.json()["cases"][0]["question"].startswith("What does")
    # seed.jsonl should exist with exactly one line
    seed_path = project_tmp / "test_cases" / "seed.jsonl"
    lines = seed_path.read_text().strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["ground_truth"] == "the lazy dog"
