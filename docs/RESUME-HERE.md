# Resume Here — Project State (last touched 2026-05-23, 15:40 PT)

This note exists so the next working session picks up cleanly. Read it
once, then delete or update it when you reach M2 done.

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
2. **`claude` CLI invocation in `agent_runner.run_agent()`** — the
   surrounding plumbing (snapshot guard + log capture + lane semantics)
   is real and tested. The exact CLI surface for headless agent
   invocation is the one open piece; today's code uses
   `claude --print --system-prompt-file ...` as a placeholder. Verify
   with `claude --help` and adjust the `cmd` list in `run_agent()`.
3. **Subset-eval inner loop** — `scripts/eval.py --subset N` selects K
   most-informative cases for blue-team's inner iterations. Plan says M3.
4. **Response cache** (`pipeline/cache.py`) — M3 per plan.
5. **Drift check** — `judge.drift_check()` re-scores random history
   pairs. M3 per plan.
6. **Dashboard view** — `routes/Run.tsx` + WebSocket stream. Some
   minimal charts in M2 per plan; deeper polish in M5.
7. **Optimization-method skills** — Bayesian / grid-sweep / ablation /
   PSO. M4 per plan.

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
