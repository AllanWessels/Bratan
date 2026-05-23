# Resume Here — Project State (last touched 2026-05-23, 16:28 PT)

Session ended at the user's 16:30 PT hard stop. Pick up tomorrow.

## Honest milestone accounting (against the approved plan)

| Milestone | Status | What's missing |
|---|---|---|
| **M0 — bootstrap** | ✅ Done | — |
| **M1 — wizard + authoring UI + pipeline contracts** | ✅ Done | — |
| **M2 — smoke loop + live dashboard** | ⚠️ ~85% | Frontend `routes/Run.tsx` + WebSocket stream (live loop dashboard); prose `docs/metrics.md` |
| **M3 — cost & reliability controls** | ❌ Not started | `pipeline/cache.py` (disk-backed response cache), `eval.py --subset` (informative-case selection), `judge.drift_check()`, `pipeline/budget.py`, `docs/cost-controls.md` |
| **M4 — optimization-method skills** | ⚠️ Partial | 4 SKILL.md files shipped (ablation, grid-sweep, bayesian-optimization, particle-swarm). `scripts/sweep.py` shared runner still missing. |
| **M5 — polish + extra adapters + CI** | ❌ Not started | Functional Qdrant / Pinecone / Weaviate / pgvector adapters (today: NotImplementedError stubs); dashboard polish; `docs/architecture.md`; `.github/workflows/ci.yml`; the GPU-skipped seed-workflow integration test |

Roughly **3 of 6 milestones done**, with M2 substantially advanced and
M4 partially landed. **Bonus over the plan:** a 124-test integration /
acceptance / unit harness was not in the original plan but was built at
the user's request.

## Big open item: end-to-end never actually run

The `claude` CLI invocation flags inside `pipeline/agent_runner.py` were
verified against `claude --help` (v2.1.150), but the full round trip —
loop spawns claude → agent edits `pipeline/` → commit lands →
`stop_criteria` halts on convergence — has **not been ridden against a
real Anthropic key**. First task tomorrow should be a single-iteration
live run with `--budget-usd 1.0` as a safety net.

## Priority order for tomorrow

1. **Live end-to-end smoke** — author ~5 seed cases in the UI, run
   `loop.py --iterations 1 --budget-usd 1.0`, watch a real Sonnet 4
   round trip from red → blue → judge, confirm a report lands.
2. **`scripts/sweep.py`** — closes M4. ~80 LOC. Reads/writes
   `pipeline/config.yaml`, defers eval to `eval.py --subset`,
   oracle-validates the winner. The four skills already expect this
   interface.
3. **M3 — `pipeline/cache.py`** — disk-backed response cache keyed by
   `(model, prompt_hash, temperature)`. Wraps both `query._call_anthropic`
   and `judge._call_anthropic`. Re-runs become near-free.
4. **M3 — `eval.py --subset N`** — pick the K most-informative cases
   (recently flipped or near 0.6) for blue-team's inner iterations.
5. **M3 — `judge.drift_check()`** — re-score 5 random history pairs.
   Feed result into the rolling-drift state that `stop_criteria` already
   reads.
6. **M2 — live dashboard** — `routes/Run.tsx` + WebSocket stream at
   `/api/loop/stream`. Plan called for minimal charts here; M5 polishes.
7. **M5 — at least one additional adapter** — Qdrant is the highest-ROI
   pick (open-source, popular, has native BM25 for `hybrid_query`).
8. **M5 — `.github/workflows/ci.yml`** — `uv sync && ruff && pytest`
   plus `cd ui/frontend && npm test`. The harness is in place; CI
   should just gate PRs.

## Git state

- 14 commits on `main`, all pushed to
  `https://github.com/AllanWessels/Bratan.git`.
- Working tree clean (this RESUME-HERE update is the only diff in
  flight when you read this).

## Where the project is

**M0 done.** uv project, deps, Makefile, .gitignore, git initialized.

**M1 done.** Setup wizard + seed-authoring UI + naive pipeline + adapter
contract. End-to-end smoke verified: backend boots, GPU detected (RTX 5080,
16 GB), config save + seed save both write to disk in the exact shape
`test_cases/schema.md` requires.

**M2 functionally complete** (commits `M2: judge.py` through `M2: scripts/loop.py`):
- `pipeline/judge.py` — prejudge/oracle router with deterministic
  recall@5, JSON-tolerant verdict parser, graceful no-LLM fallback.
  13 unit tests, all pass.
- `pipeline/metrics.py` — `build_report()` aggregates verdicts into the
  full `IterationReport`. `write_report()` + `append_regressions_md()` +
  `load_latest()` for persistence.
- `pipeline/stop_criteria.py` — 7-criterion `evaluate()` returning the
  `stop_reason` enum.
- `pipeline/agent_runner.py` — subprocess wrapper for red/blue/judge
  agents plus the `config_snapshot_guard()` context manager that reverts
  any unauthorized edits to `bratan.config.yaml` after the agent exits
  (the lane-boundary enforcer the plan flags as risk #7). 4 tests.
- `scripts/eval_single.py` — red-team CLI, one case → human or JSON output.
- `scripts/eval.py` — full-corpus runner, writes `/reports/run-<ts>.json`.
- `scripts/loop.py` — orchestrator. Per iteration: optional red →
  blue → commit pipeline/ → eval (oracle) → consult `stop_criteria` →
  loop. `--iterations 0` is the baseline-only path; `--no-agents`
  exercises the eval/report half without invoking `claude`.

Test suite: **34 passing, 1 GPU-skipped.**

Judge grading prompts (human anchors) at
`agents/judge/prompts/{correctness,faithfulness}.md`.

The approved plan lives at:
`/home/allan/.claude/plans/read-all-of-the-cozy-ladybug.md`

## How to verify it still works (1 minute)

```bash
cd /home/allan/projects/bratan
export PATH="$HOME/.local/bin:$PATH"
uv sync                                                # idempotent
uv run pytest tests/test_contract_smoke.py -v          # 4 tests, all pass
uv run uvicorn ui.backend.app:app --port 8000 &        # start backend
sleep 2
curl -sS http://127.0.0.1:8000/api/health              # {"ok":true,...}
curl -sS -X POST http://127.0.0.1:8000/api/setup/probe # GPU + VRAM JSON
kill %1
```

For the frontend:
```bash
cd ui/frontend
npm install                                            # first-time only
npm run typecheck && npm run build                     # both clean
npm run dev                                            # http://localhost:5173
```

Or to run both together: `make ui`.

## Decisions locked from the interview

1. **User contract.** User brings: `/corpus/`, vector DB choice (Chroma
   default; Qdrant/Pinecone/Weaviate/pgvector adapters are scaffolded as
   M5 stubs), and seed cases. Blue team owns everything else in
   `/pipeline/`.
2. **UI stack.** FastAPI + Vite/React/TypeScript. TanStack Query +
   Zustand + Tailwind. No component library.
3. **Build order.** M1 (UI) shipped first, M2 (smoke loop) next.
4. **GPU is used everywhere.** Local BGE embedder + BGE reranker + Qwen
   prejudge for inner-loop iterations. Sonnet 4 remains the oracle on
   every consequential decision (accept/revert, regression scoring,
   convergence, drift checks). The prejudge is a sample-efficiency tool,
   never a quality gate.
5. **Two config files.** `bratan.config.yaml` is user-owned (written by
   the setup wizard: vector DB, costs, models, stopping criteria, judge
   weights). `pipeline/config.yaml` is blue-team-owned (chunk size, k,
   rrf_k, etc.). Blue team must never touch `bratan.config.yaml`. M2's
   `pipeline/agent_runner.py` must enforce this with a pre/post snapshot.

## Important conventions

- **`test_cases/schema.md` is the canonical anchor.** Persisted seed cases
  use exactly its field names: `source_passages`, `line_start`, `line_end`,
  `created_by` ("human" / "red-team"), the 8 failure categories
  (incl. `straightforward`). `ui/backend/schemas.py` and the frontend TS
  types are aligned. Do not drift.
- **Internal chunk metadata** uses `start_line/end_line` (storage detail).
  This is a deliberate split from PassageRef's `line_start/line_end` —
  the overlap check in `seed_store._passage_overlaps_any_hit` handles
  both.
- **`pipeline/query.py` is a naive baseline** (vector-only top-k +
  grounded prompt). M2 blue team will improve it; the public function
  signatures (`search_corpus`, `answer`, `naive_pipeline_score`) are the
  contract M2 must keep.
- **No vLLM is running locally yet.** The setup wizard probes
  `http://localhost:8001` and shows it as unreachable. M2 needs to
  document how to launch:
  `vllm serve Qwen/Qwen2.5-14B-Instruct-AWQ --port 8001`. NOTE: original
  plan said Qwen-32B-AWQ but VRAM is 16 GB on this machine — downsize to
  14B-AWQ.

## What's still open

1. **`docs/metrics.md`** — prose for the existing `IterationReport` schema.
   Trivial; just describe what's already in code.
2. **Subset-eval inner loop** — `scripts/eval.py --subset N` selects K
   most-informative cases for blue-team's inner iterations. Plan says M3.
3. **Response cache** (`pipeline/cache.py`) — M3 per plan.
4. **Drift check** — `judge.drift_check()` re-scores random history
   pairs. M3 per plan.
5. **Dashboard view** — `routes/Run.tsx` + WebSocket stream. Some
   minimal charts in M2 per plan; deeper polish in M5.
6. **Optimization-method skills** — Bayesian / grid-sweep / ablation /
   PSO. M4 per plan.

## Git remote

`origin` is set to `https://github.com/AllanWessels/Bratan.git` (empty
repo as of this session). When ready to publish:
```bash
git push -u origin main
```
Not pushed yet — that needs the user's explicit OK.

### Quick demo (once you have ANTHROPIC_API_KEY + ~5 seed cases):
```bash
make ui                                      # author seed cases
uv run python pipeline/ingest.py             # index /corpus/
uv run python scripts/eval_single.py --case-id <id>
uv run python scripts/eval.py --iteration 0  # full eval -> /reports/latest.json
uv run python scripts/loop.py --iterations 1 --no-agents   # iterate without agents
uv run python scripts/loop.py --iterations 3 --budget-usd 1.0   # real loop
```

## Known gaps + risks

- **`/api/setup/save-step` shape**: the step `data` payload must be the
  matching slice of `BratanConfig` (e.g., `{"data":{"project":{...}}}`,
  not `{"data":{"project_basics":{...}}}`). The frontend already does
  this correctly; just noting it for anyone hitting the API by hand.
- **`pipeline/config.yaml` still references `voyage-3`** as the embedding
  model. The new source of truth for embedding model is
  `bratan.config.yaml`'s `models.embedding_model` (default
  `BAAI/bge-large-en-v1.5`). `pipeline/ingest.py` already reads from the
  right place; the `voyage-3` entry in the old config is dead text.
- **VRAM budget.** 16 GB on this machine. The plan originally sized for
  24 GB. With Qwen-14B-AWQ (~9 GB) + BGE-large (~1.3 GB) + bge-reranker
  (~2.3 GB) ≈ 12.6 GB. Fits, but tight. M2 should add a CPU-fallback
  toggle for the prejudge if VRAM pressure shows up.

## What NOT to do

- Don't downgrade the oracle (Sonnet 4). It is the load-bearing
  assumption of the loop. CLAUDE.md is emphatic.
- Don't modify `test_cases/schema.md`, `corpus/`, or grading prompts
  mid-run.
- Don't write tests for the agent loop itself; tests live around the
  pipeline + adapters + cache (M5).
