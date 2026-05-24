# Resume Here — Project State (last touched 2026-05-23, 18:50 PT)

All six milestones from the approved plan have landed. The framework is
feature-complete pending the live end-to-end run against a real
Anthropic key (which requires the user to author seed cases first).

## Milestone accounting (against the approved plan)

| Milestone | Status | Notes |
|---|---|---|
| **M0 — bootstrap** | ✅ Done | uv project, deps, Makefile, .gitignore, git initialized |
| **M1 — wizard + authoring UI + pipeline contracts** | ✅ Done | 8-step setup wizard, seed authoring with on-the-fly validation, ChromaDB adapter, naive pipeline baseline |
| **M2 — smoke loop + live dashboard** | ✅ Done | judge + metrics + stop_criteria + eval + loop + agent_runner, plus the live `/run` dashboard with WebSocket stream |
| **M3 — cost & reliability controls** | ✅ Done | `pipeline/cache.py`, `pipeline/budget.py`, `judge.drift_check()`, `scripts/eval.py --subset N`, `--drift-check` |
| **M4 — optimization-method skills** | ✅ Done | Four `SKILL.md` files (ablation / grid-sweep / bayesian-optimization / particle-swarm) + `scripts/sweep.py` shared runner with grid / ablation / bayesian strategies and oracle-validation of winners |
| **M5 — polish + extra adapters + CI** | ✅ Done | Functional Qdrant adapter (in-memory hermetic tests), `.github/workflows/ci.yml`, `docs/metrics.md` (467-line prose), the "portfolio → closed-loop" language sweep, dashboard polish (M5 nice-to-have left: Pinecone/Weaviate/pgvector adapters; chart drill-down). |

**Test suite:** 140 backend (1 GPU-skipped) + 38 frontend unit + 2 Playwright
E2E = **180 tests**. `make test` runs all three layers (E2E adds ~30s
locally, ~3min on a cold CI runner including browser install).
`.github/workflows/ci.yml` gates PRs and uploads the Playwright HTML report
on failure.

## The only thing not yet exercised

The full red → blue → judge loop has not been ridden against a **real
Anthropic API key + a real seed set + a real corpus**. Every layer is
tested in isolation, the schemas line up end-to-end, but the round trip
through the `claude` CLI has not burned a single live token.

**To do that:**
1. Drop documents into `/corpus/`.
2. `make ui` → walk the setup wizard → author ~5 seed cases.
3. `uv run python pipeline/ingest.py` → index the corpus.
4. `uv run python scripts/loop.py --iterations 1 --budget-usd 1.0` → one
   real round trip with a safety net on spend.
5. Open `/run` in the browser to watch the report stream in.

## How to verify quickly (1 minute, no API key needed)

```bash
cd /home/allan/projects/bratan
export PATH="$HOME/.local/bin:$PATH"
uv sync                                                # idempotent
uv run pytest tests/ -q                                # 140 passing
(cd ui/frontend && npm install && npm run typecheck && npm run build && npm test)
uv run python scripts/eval.py --help                   # confirms --subset / --drift-check
uv run python scripts/sweep.py --help                  # confirms M4 runner
uv run python scripts/loop.py --iterations 0 --no-agents   # baseline path
```

## Repo layout (after this session)

```
/.github/workflows/ci.yml          GitHub Actions: ruff + pytest + npm typecheck/build/test
/agents/                           three AGENTS.md + judge prompts
/skills/                           10 SKILL.md files (6 pipeline-shape + 4 optimization-method)
/pipeline/
  judge.py        prejudge/oracle router + drift_check
  query.py        cache-wrapped answer()
  ingest.py
  embeddings.py
  metrics.py      IterationReport + persistence
  stop_criteria.py   7 stop conditions
  agent_runner.py    claude CLI wrapper + config-snapshot guard
  cache.py        disk-backed (model, prompt, T) cache         ← M3
  budget.py       BudgetTracker dataclass                       ← M3
  adapters/
    base.py        ChunkRecord + QueryHit + ABC
    chroma.py      ✅ default
    qdrant.py      ✅ functional (hermetic in-memory tests)
    pinecone.py    ✅ functional (recording mock; Pinecone has no in-mem mode)
    weaviate.py    ✅ functional + native hybrid (recording mock)
    pgvector.py    ✅ functional (recording mock pinning SQL shape)
    (custom backends: see docs/custom-adapter.md, wired via "Other" wizard option)
  prompts/generation.md
  config.yaml     blue-team's lane
  CHANGELOG.md
/ui/
  backend/
    app.py        FastAPI: setup + corpus + seed + reports + loop  ← +dashboard routes
    schemas.py
    config_store.py
    seed_store.py
    system_probe.py
    loop_control.py    Popen lifecycle for /api/loop/*            ← M2 dashboard
  frontend/src/
    routes/
      SetupWizard.tsx
      Authoring.tsx
      Run.tsx        ← M2 dashboard
      Settings.tsx
    api/ + store/ + components/ + lib/
/scripts/
  loop.py         orchestrator
  eval.py         full eval; --subset, --drift-check               ← extended in M3
  eval_single.py  one-case CLI (red team)
  sweep.py        hyperparameter search runner                     ← M4 close
  serve_ui.py     dev launcher
/test_cases/      append-only; schema.md is the anchor
/corpus/          your documents
/reports/         judge writes; dashboard reads
/docs/
  RATIONALE.md    "why the architecture looks like this"           ← closed-loop reframe
  metrics.md      every IterationReport field + its semantics      ← M5 docs
  RESUME-HERE.md  this file
/tests/           pytest harness (140 cases)
  conftest.py     cache sandbox per test
  integration/
    test_dashboard_api.py
    test_ingest_query_pipeline.py
    test_eval_end_to_end.py
    test_api_acceptance.py
  + unit files for adapters / cache / budget / drift / ...
```

## Operating note: fan test execution out to sub-agents

Whenever a change touches more than a single module, run the verification
in a sub-agent (`Agent` tool with `run_in_background: true`) rather than
in-line. The full suite — pytest + vitest + Playwright + live ingest — is
multi-minute and produces a lot of log spam (torch + huggingface +
chromadb + vite); running it in the main conversation burns context and
blocks the session.

The pattern that works:
1. Brief the sub-agent with a numbered checklist (e.g. the 10 checks
   the "end-to-end verifier" uses).
2. Tell it where credentials live (`.env`, gitignored).
3. Use **don't-stop-until-PASS** semantics — the agent loops on fixes
   until every check is green.
4. The main session continues with other work and waits for the agent's
   completion notification. Do NOT tail the agent's transcript file
   (it overflows context per the system warning).

This is why the "no such table: tenants" + stale Sonnet model id bugs
slipped — they shipped without an end-to-end exercise against the live
backend. The verifier pattern catches that class of bug.

## Common state-poisoning failures

ChromaDB holds in-process singleton state. Wiping `.chroma/` on disk does
**not** clear the in-memory client. Verifier agents run Playwright with
`reuseExistingServer: true` and share the user's dev backend — so any
in-memory poisoning from a verifier cycle flows straight into the user's
next session.

**Symptom catalogue — all the same root cause (stale chromadb client
surviving a disk wipe):**

- `OperationalError: no such table: tenants`
- `OperationalError: no such table: databases`
- `Nothing found on disk` (chroma persistence path mismatch)
- `dim mismatch` (collection was created against a different embedding
  model than the live config now points at)

**Recovery recipe** (run in order, do not skip steps):

1. `curl -sf -X POST http://localhost:8005/api/system/reset-vector-store`
   — clears the in-memory client where the backend supports it.
2. `pkill -9 -f "uvicorn.*ui.backend.app"` — kill the FastAPI process so
   any surviving chromadb singleton is gone.
3. `rm -rf .chroma bratan.config.yaml .bratan-setup.json` — disk wipe.
4. Restart uvicorn fresh.
5. `curl -sf http://localhost:8005/api/corpus/search -d '{"query":"x","k":1}' -H "Content-Type: application/json"`
   — must return HTTP 200 (not 500), even against an empty corpus.

If step 5 returns 500, GOTO step 2. The "reset endpoint" alone is not
sufficient — process-level restart is the only reliable fix.

## Decisions worth re-reading before changing things

1. **Two configs.** `bratan.config.yaml` is user-owned (setup wizard).
   `pipeline/config.yaml` is blue-team-owned. The snapshot guard in
   `pipeline/agent_runner.py` reverts any unauthorized blue-team edit
   to the user-owned file.

2. **Cache is opt-in by `cfg.cost.cache_ttl_hours > 0`.** The wrapper
   in `judge._select_caller` and `query._call_anthropic_normalized` is
   explicit — no monkey-patching. Each test gets a sandboxed cache dir
   via `tests/conftest.py` so state doesn't bleed.

3. **`recall@5` is deterministic** and runs regardless of judge mode.
   Only `correctness` + `faithfulness` LLM calls differ between
   prejudge and oracle.

4. **CLAUDE.md's invariant — the judge that scores the report is never
   downgraded.** `scripts/sweep.py` enforces this by oracle-validating
   every winner against the incumbent before persisting. If the oracle
   disagrees with the prejudge ranking, the sweep is discarded with a
   low-confidence warning.

5. **Append-only test set.** `seed.jsonl` is never modified by agents.
   Red team writes only to `test_cases/generated/<ts>.jsonl`.

## Open items, in rough priority order

1. **Live end-to-end run.** See "The only thing not yet exercised" above.
2. **Additional vector adapters** — Pinecone / Weaviate / pgvector.
   Qdrant is the proof the contract works; the others are mostly
   mechanical follow-on.
3. **Chart drill-down** in `/run` — click a point on the composite-
   over-iterations chart, see the full IterationReport for that run.
   Endpoint (`/api/reports/{timestamp}`) is already wired and typed.
4. **Hybrid retrieval via Qdrant's sparse vectors** — today
   `QdrantAdapter.hybrid_query_if_supported` returns `None` with a TODO.
   Real native BM25 needs schema-level changes to the upsert path.
5. **Live wizard "Test connection" button for Qdrant** — backend
   `system_probe.test_vectordb` already supports it; verify the wizard's
   Step 2 panel triggers it correctly now that Qdrant is enabled.

## Git state

- **20 commits on `main`** (was 14 at start of this session).
- All pushed to `https://github.com/AllanWessels/Bratan.git` (once the
  push step at the end of this session completes).
- Working tree clean.
