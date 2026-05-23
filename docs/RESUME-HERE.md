# Resume Here — Project State (last touched 2026-05-23, 15:25 PT)

This note exists so the next working session picks up cleanly. Read it
once, then delete or update it when you reach M2 done.

## Where the project is

**M0 done.** uv project, deps, Makefile, .gitignore, git initialized.

**M1 done.** Setup wizard + seed-authoring UI + naive pipeline + adapter
contract. End-to-end smoke verified: backend boots, GPU detected (RTX 5080,
16 GB), config save + seed save both write to disk in the exact shape
`test_cases/schema.md` requires.

**M2 partial-prep.** Judge grading prompts are pre-authored under
`agents/judge/prompts/{correctness,faithfulness}.md`. Everything else for
M2 is still pending.

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

## What's missing for M2 (smoke loop)

In priority order:

1. **`pipeline/judge.py`** — router with two named functions: `prejudge()`
   (calls local Qwen via vLLM at T=0) and `oracle_judge()` (calls Sonnet 4
   at T=0). Both render the prompts under `agents/judge/prompts/`.
   `judge(case, answer, chunks, mode)` dispatcher.
2. **`pipeline/metrics.py`** — per-iteration report builder (composite,
   per_category, pass_rate_at_0_6, regressions, recoveries, cost,
   latency, pipeline_manifest_hash, test_set_size, drift, stop_reason,
   judge_weights_hash). Full schema lives in the approved plan's "Metrics
   reported per iteration" section.
3. **`pipeline/stop_criteria.py`** — evaluates the 7 stop conditions and
   returns the `stop_reason` enum (convergence / budget / max_iterations /
   anchor_regression / judge_drift / blue_stall / manual).
4. **`scripts/eval_single.py`** — runs `query.answer()` for one case ID,
   scores with oracle, prints JSON. Red team calls this.
5. **`scripts/eval.py`** — runs all cases, writes
   `/reports/run-<ts>.json` + `/reports/latest.json` + appends
   `/reports/regressions.md`. Supports `--subset` (M3) and
   `--judge {prejudge,oracle}`.
6. **`scripts/loop.py`** — flesh out the 51-line stub. Sequence
   red→blue→judge via subprocess `claude --system-prompt
   @agents/<name>/AGENTS.md`. Convergence + budget gates via
   `stop_criteria`. Per-iteration commit prefix `loop-iter-<n>:`.
7. **`pipeline/agent_runner.py`** — subprocess helper + the
   `bratan.config.yaml` snapshot-and-revert guard.
8. **`docs/metrics.md`** — full report schema documentation.
9. **Dashboard view** (frontend) — `routes/Run.tsx` with WebSocket stream
   of latest report. M2 ships minimal charts; M5 polishes.

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
