"""Integration: POST /api/system/reset-vector-store.

Covers the confirm-guard contract (4xx without confirm, 200 with either
?confirm=true or {"confirm": true} body), the chroma-only restriction (400
for managed adapters), the project-root escape guard (400 for paths
outside PROJECT_ROOT), and the in-process client drop after reset.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from pipeline.adapters import chroma as chroma_adapter_mod


@pytest.fixture
def client(tmp_project: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Wire the FastAPI app at the tmp project root.

    Same pattern as test_api_acceptance.py: PROJECT_ROOT + CONFIG_PATH on
    the app module both get rebound to the tmp project so config writes
    and chroma_path resolution stay hermetic.
    """
    from ui.backend import app as app_mod

    monkeypatch.setattr(app_mod, "PROJECT_ROOT", tmp_project)
    monkeypatch.setattr(app_mod, "CONFIG_PATH", tmp_project / "bratan.config.yaml")

    # Belt-and-braces: clear any live ChromaAdapter registry left over from
    # an earlier test. We don't want a different test's adapter to inflate
    # client_dropped here.
    chroma_adapter_mod._LIVE_ADAPTERS.clear()

    return TestClient(app_mod.app)


def _write_config(
    tmp_project: Path,
    *,
    adapter: str = "chroma",
    chroma_path: str | None = None,
) -> Path:
    """Write a minimal bratan.config.yaml the reset endpoint can load."""
    cfg = {
        "project": {
            "project_name": "reset-test",
            "corpus_path": str(tmp_project / "corpus"),
            "seed_target_n": 10,
        },
        "vector_db": {
            "adapter": adapter,
            "chroma_path": chroma_path if chroma_path is not None else str(tmp_project / ".chroma"),
            "chroma_collection": "reset_test_corpus",
        },
    }
    path = tmp_project / "bratan.config.yaml"
    path.write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Confirm-guard contract
# ---------------------------------------------------------------------------


def test_reset_requires_confirm(client: TestClient, tmp_project: Path) -> None:
    """No confirm = 400 with a message that names the confirm requirement.

    Accidental curl hits (no body, no query param) must NOT wipe the
    vector store. This is the load-bearing guard against operator typos.
    """
    _write_config(tmp_project)

    r = client.post("/api/system/reset-vector-store")
    assert r.status_code == 400
    detail = r.json()["detail"]
    # Message must mention "confirm" so the operator understands how to fix.
    assert "confirm" in detail.get("message", "").lower()
    assert detail.get("error") == "confirmation_required"

    # The .chroma directory must still be there — we did NOT wipe.
    assert (tmp_project / ".chroma").exists()


def test_reset_with_confirm_query_param_succeeds(
    client: TestClient, tmp_project: Path
) -> None:
    """?confirm=true must satisfy the guard and succeed against an existing
    .chroma path. Response advertises the wiped path."""
    _write_config(tmp_project)
    # Pre-populate something inside .chroma so the wipe is observable.
    chroma_dir = tmp_project / ".chroma"
    chroma_dir.mkdir(exist_ok=True)
    (chroma_dir / "sentinel.txt").write_text("present-before-reset")

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["path_wiped"] is not None
    assert body["path_wiped"].endswith(".chroma")

    # On-disk reality: either the path is gone OR (if recreated by a side
    # effect) it must be empty.
    if chroma_dir.exists():
        assert not any(chroma_dir.iterdir()), (
            f".chroma not wiped: still contains {list(chroma_dir.iterdir())}"
        )


def test_reset_with_confirm_body_succeeds(
    client: TestClient, tmp_project: Path
) -> None:
    """{"confirm": true} as JSON body must also satisfy the guard.

    Documenting two ways in is a usability win for the wizard's reset
    button — query string for shell curl, body for typed clients.
    """
    _write_config(tmp_project)
    chroma_dir = tmp_project / ".chroma"
    chroma_dir.mkdir(exist_ok=True)

    r = client.post(
        "/api/system/reset-vector-store",
        json={"confirm": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True


def test_reset_with_confirm_false_body_still_400(
    client: TestClient, tmp_project: Path
) -> None:
    """An explicit {"confirm": false} body must NOT satisfy the guard. The
    operator must AFFIRM, not opt-out of the affirmation."""
    _write_config(tmp_project)

    r = client.post(
        "/api/system/reset-vector-store",
        json={"confirm": False},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Adapter restriction
# ---------------------------------------------------------------------------


def test_reset_rejects_non_chroma_adapter(
    client: TestClient, tmp_project: Path
) -> None:
    """Managed adapters (qdrant, pinecone, weaviate, pgvector) must be
    refused with 400 and a helpful message naming the actual adapter —
    the user has to clear those via the provider's console."""
    _write_config(tmp_project, adapter="qdrant")

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.get("error") == "adapter_not_supported"
    msg = detail.get("message", "")
    # Helpful message must call out the current adapter so the user knows
    # why it failed.
    assert "qdrant" in msg.lower()


@pytest.mark.parametrize("adapter", ["pinecone", "weaviate", "pgvector"])
def test_reset_rejects_other_managed_adapters(
    client: TestClient, tmp_project: Path, adapter: str
) -> None:
    """Same restriction must hold for every non-chroma adapter. Parametrize
    to make the matrix explicit so a future adapter addition has to opt
    in to reset support."""
    _write_config(tmp_project, adapter=adapter)

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "adapter_not_supported"


# ---------------------------------------------------------------------------
# In-process client drop
# ---------------------------------------------------------------------------


def test_reset_drops_in_process_client(
    client: TestClient, tmp_project: Path, stub_embedder
) -> None:
    """Pre-ingest something against the live in-process client, then call
    reset, then re-query (subprocess mode) and confirm we get [] back.

    This is the bug that drove the whole structural change: chromadb's
    Rust bindings hold per-path singletons. Wiping the directory under a
    live client used to make the next query 500 with "Nothing found on
    disk". The reset endpoint MUST drop in-process refs so a subsequent
    subprocess query against a fresh empty path returns [].
    """
    from pipeline import ingest
    from pipeline.adapters.chroma import ChromaAdapter
    from ui.backend.config_store import load as load_cfg

    config_path = _write_config(tmp_project)
    cfg = load_cfg(config_path)
    cfg.project.corpus_path = str(tmp_project / "corpus")

    # Seed a tiny corpus so ingest writes something.
    (tmp_project / "corpus").mkdir(exist_ok=True)
    (tmp_project / "corpus" / "fox.md").write_text("# Fox\nThe quick brown fox.\n")

    ingest._ingest_sync(cfg)

    # Sanity: an in-process adapter (not subprocess) sees the data.
    pre_adapter = ChromaAdapter(
        path=tmp_project / ".chroma",
        collection="reset_test_corpus",
        subprocess_query=False,
    )
    assert pre_adapter.count() >= 1, (
        "ingest didn't write anything — test setup is broken"
    )

    # Reset.
    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    # client_dropped should be True because we just registered pre_adapter
    # AND the ingest path opened its own adapter.
    assert body["client_dropped"] is True

    # Module-level registry must be empty after the drop.
    assert len(chroma_adapter_mod._LIVE_ADAPTERS) == 0, (
        f"_LIVE_ADAPTERS not cleared: {chroma_adapter_mod._LIVE_ADAPTERS}"
    )

    # Re-query through a fresh subprocess-mode adapter against the now-wiped
    # path. Returns [] gracefully — the structural fix.
    post_adapter = ChromaAdapter(
        path=tmp_project / ".chroma",
        collection="reset_test_corpus",
        subprocess_query=True,
    )
    assert post_adapter.vector_query([1.0, 0.0], k=3) == []


def test_reset_idempotent_when_path_already_gone(
    client: TestClient, tmp_project: Path
) -> None:
    """Calling reset twice in a row must succeed both times: the second
    call has nothing to wipe (path_wiped=None) but in-process refs may
    still have been registered between calls."""
    _write_config(tmp_project)
    chroma_dir = tmp_project / ".chroma"
    if chroma_dir.exists():
        # Remove the autocreated tmp_project .chroma so the first reset is
        # already a no-op on disk.
        import shutil

        shutil.rmtree(chroma_dir)

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 200
    assert r.json()["path_wiped"] is None

    # Second call — still 200.
    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 200
    assert r.json()["path_wiped"] is None


# ---------------------------------------------------------------------------
# Project-root escape & protected-path guards
# ---------------------------------------------------------------------------


def test_reset_refuses_to_escape_project_root(
    client: TestClient, tmp_project: Path
) -> None:
    """A maliciously- or accidentally-configured chroma_path that resolves
    outside PROJECT_ROOT must be refused. The endpoint MUST NOT
    `shutil.rmtree(/etc)` even if the operator typoed chroma_path."""
    # Configure an absolute path that's outside the tmp project.
    _write_config(tmp_project, chroma_path="/etc")

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.get("error") == "path_outside_project"
    msg = detail.get("message", "")
    # Should reference the project root the path escaped from.
    assert "project root" in msg.lower() or "escape" in msg.lower()


def test_reset_refuses_traversal_above_project_root(
    client: TestClient, tmp_project: Path
) -> None:
    """A relative chroma_path like `../../escape` that resolves outside the
    project root must also be refused. Relative-path resolution happens
    before the safety check, so the resolved absolute path is what's
    compared."""
    # Use enough `..` segments to guarantee an escape regardless of how
    # deep tmp_project sits in the tmp_path hierarchy. We anchor to /tmp so
    # the resulting path is definitively not under tmp_project.
    _write_config(tmp_project, chroma_path="../../../../../../../../../../tmp/bratan-escape")

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "path_outside_project"


def test_reset_refuses_protected_directory(
    client: TestClient, tmp_project: Path
) -> None:
    """Even when chroma_path stays inside PROJECT_ROOT, it must not be the
    `corpus/` or `test_cases/` or `reports/` anchor. The belt-and-braces
    check exists because a relative `./corpus` path passes the
    project-root containment check but still must not be wiped."""
    _write_config(tmp_project, chroma_path="./corpus")

    r = client.post("/api/system/reset-vector-store?confirm=true")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.get("error") == "path_is_protected"
    # The corpus directory must STILL exist (we did NOT wipe it).
    assert (tmp_project / "corpus").exists()
