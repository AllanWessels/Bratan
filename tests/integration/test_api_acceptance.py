"""Integration: FastAPI acceptance flow — the M1 user story end-to-end.

Walks: /api/health -> setup wizard (probe + save-step x N + finish) ->
config snapshot -> ingest -> corpus search -> seed validate -> seed save -> seed list.

Only stubs the GPU embedder and Anthropic. Everything else (FastAPI routing,
Pydantic validation, config YAML persistence, chromadb upsert/query, seed.jsonl
append + dedup) is real.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_project: Path, stub_embedder, fake_anthropic, monkeypatch: pytest.MonkeyPatch):
    # The FastAPI app reads CONFIG_PATH at request time, computed from PROJECT_ROOT
    # at import time. We rebind both to the tmp project.
    from ui.backend import app as app_mod

    monkeypatch.setattr(app_mod, "PROJECT_ROOT", tmp_project)
    monkeypatch.setattr(app_mod, "CONFIG_PATH", tmp_project / "bratan.config.yaml")

    # Drop a tiny corpus the user would have created before launching the UI.
    (tmp_project / "corpus" / "fox.md").write_text(
        "# Fox\nThe quick brown fox jumps over the lazy dog.\nFoxes are clever.\n"
    )
    (tmp_project / "corpus" / "pelican.md").write_text(
        "# Pelican\nPelicans dive from great heights to catch fish.\n"
    )

    return TestClient(app_mod.app)


def test_first_touch_acceptance_flow(client, tmp_project: Path) -> None:
    # 1. Health
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True

    # 2. Setup state — wizard not yet completed
    r = client.get("/api/setup/state")
    body = r.json()
    assert body["setup_completed"] is False
    assert body["current_step"] == 1

    # 3. Probe — should detect *something* (GPU info or not, vLLM url present)
    r = client.post("/api/setup/probe")
    probe = r.json()
    assert "gpu" in probe and "vllm_reachable" in probe and "anthropic_key_set" in probe

    # 4. Walk all 8 wizard steps with the matching slice of BratanConfig as `data`.
    step_payloads = [
        {
            "step": 1,
            "data": {
                "project": {
                    "project_name": "acceptance",
                    "corpus_path": str(tmp_project / "corpus"),
                    "seed_target_n": 10,
                }
            },
        },
        {"step": 2, "data": {"vector_db": {"adapter": "chroma", "chroma_path": str(tmp_project / ".chroma"), "chroma_collection": "acceptance_corpus"}}},
        {"step": 3, "data": {"models": {"anthropic_api_key": "stub-key-for-tests"}}},
        {"step": 4, "data": {"cost": {"usd_per_run": 1.0}}},
        {"step": 5, "data": {"project": {"seed_target_n": 10}}},
        {"step": 6, "data": {}},
        {"step": 7, "data": {"stop": {"max_iterations": 3}}},
        {"step": 8, "data": {"judge_weights": {"correctness": 0.4, "recall_at_5": 0.3, "faithfulness": 0.3}}},
    ]
    for payload in step_payloads:
        r = client.post("/api/setup/save-step", json=payload)
        assert r.status_code == 200, r.text

    # 5. Finish setup
    r = client.post("/api/setup/finish")
    assert r.status_code == 200
    assert r.json()["setup_completed"] is True
    assert (tmp_project / "bratan.config.yaml").exists()

    # 6. Corpus listing
    r = client.get("/api/corpus/files")
    files = r.json()
    paths = {f["path"] for f in files}
    assert "fox.md" in paths and "pelican.md" in paths

    # 7. Ingest via the synchronous path so we don't need to poll.
    from pipeline import ingest as ingest_mod
    from ui.backend.config_store import load as load_cfg

    cfg = load_cfg(tmp_project / "bratan.config.yaml")
    n_chunks = ingest_mod._ingest_sync(cfg)
    assert n_chunks >= 2

    # 8. Corpus search
    r = client.post("/api/corpus/search", json={"query": "fox", "k": 5})
    assert r.status_code == 200
    passages = r.json()["passages"]
    assert passages
    # Field names follow schema.md (line_start/line_end), not the old start_line/end_line
    assert "line_start" in passages[0]
    assert "line_end" in passages[0]

    # 9. Read a specific passage
    r = client.get("/api/corpus/passage", params={"path": "fox.md", "start": 2, "end": 2})
    assert r.status_code == 200
    body = r.json()
    assert "lazy dog" in body["content"]
    assert body["line_start"] == 2 and body["line_end"] == 2

    # 10. Validate a candidate seed case
    validate_payload = {
        "question": "What does the fox jump over?",
        "ground_truth": "the lazy dog",
        "passages": [{"path": "fox.md", "line_start": 2, "line_end": 2}],
        "run_pipeline": False,
    }
    r = client.post("/api/seed/validate", json=validate_payload)
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["answer_text_in_passages"] is True
    assert v["passages_in_top_k"] is True

    # 11. Save the case
    save_payload = {
        **validate_payload,
        "failure_category": "straightforward",
        "notes": "smoke",
    }
    save_payload.pop("run_pipeline", None)
    r = client.post("/api/seed/save", json=save_payload)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["ok"] is True
    assert saved["case"]["created_by"] == "human"
    assert saved["case"]["source_passages"][0]["line_start"] == 2

    # 12. List + verify the persisted JSONL matches schema.md
    r = client.get("/api/seed/list")
    listing = r.json()
    assert len(listing["cases"]) == 1
    assert listing["target_n"] == 10
    on_disk = (tmp_project / "test_cases" / "seed.jsonl").read_text().strip().splitlines()
    assert len(on_disk) == 1
    row = json.loads(on_disk[0])
    for field in ("id", "question", "ground_truth", "source_passages", "failure_category", "created_by", "created_at"):
        assert field in row
    assert row["source_passages"][0]["line_start"] == 2

    # 13. Dedup — same question must 409
    r = client.post("/api/seed/save", json=save_payload)
    assert r.status_code == 409


def test_seed_drafts_lifecycle(client, tmp_project: Path) -> None:
    # Drafts live separately from finalized cases; should round-trip via the API.
    draft = {"question": "draft q", "ground_truth": "x", "passages": [], "notes": ""}
    r = client.put("/api/seed/drafts/abc-123", json=draft)
    assert r.status_code == 200

    r = client.get("/api/seed/drafts")
    drafts = r.json()
    assert any(d.get("id") == "abc-123" for d in drafts)

    r = client.delete("/api/seed/drafts/abc-123")
    assert r.status_code == 200
    r = client.get("/api/seed/drafts")
    assert not any(d.get("id") == "abc-123" for d in r.json())
