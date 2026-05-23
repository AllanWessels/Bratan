# RAG Refiner

A self-improving RAG pipeline. Three agents — red team, blue team, judge —
iterate against a co-evolving test set until the pipeline converges on
high quality. You provide a corpus, a preferred vector DB, and a handful of
seed test cases (via a guided UI). The blue team does the rest.

## What's in this repo

```
CLAUDE.md             orientation for Claude Code; read first
docs/RATIONALE.md     why the architecture looks like this
docs/metrics.md       what every report contains (created in M2)
bratan.config.yaml    user-owned project config (written by setup wizard)
/agents/              AGENTS.md specs for the three agents
/skills/              SKILL.md files capturing reusable techniques
/pipeline/            the thing being improved — blue team owns this lane
  /adapters/          VectorDBAdapter implementations (the swap point)
  /prompts/           generation + grading templates
  config.yaml         pipeline hyperparameters (blue team mutates)
/ui/                  setup wizard + seed authoring + live dashboard
  /backend/           FastAPI app + services
  /frontend/          Vite + React app
/test_cases/          seed.jsonl + agent-generated cases (append-only)
/corpus/              your documents (you provide these)
/reports/             judge writes here, others read
/scripts/             orchestrator + eval runners + UI launcher
```

## Quickstart

```bash
# 1. Install
git clone <this-repo>
cd bratan
uv sync                       # Python deps
cd ui/frontend && npm install # frontend deps

# 2. Drop your documents into /corpus/

# 3. Launch the UI
make ui
# Backend at  http://127.0.0.1:8000
# Frontend at http://127.0.0.1:5173

# 4. The wizard walks you through:
#    project basics, vector DB choice, API keys, cost ceilings,
#    seed-target N (default 50), GPU detection, stopping criteria,
#    judge weights. Auto-save per step.
#
#    Then you author seed cases against your corpus — the UI validates
#    each case (retrievable in top-k, answer text present in chosen
#    passages, optional pipeline run) before letting you save.

# 5. Once you have your seed cases, run the loop
make loop                     # one red->blue->judge cycle
uv run python scripts/loop.py --iterations 50 --budget-usd 10
```

## What "done" looks like

The loop stops automatically when **any** stopping criterion fires
(convergence, budget, max iterations, anchor regression, judge drift, blue
stall, or manual). Each report records the `stop_reason`. The full metrics
schema lives in `docs/metrics.md`.

## Reading order if this is your first time

1. `CLAUDE.md` — system orientation
2. `/agents/judge/AGENTS.md` — the simplest agent
3. `/agents/blue-team/AGENTS.md` — the improvement agent
4. `/agents/red-team/AGENTS.md` — the adversarial agent
5. `docs/RATIONALE.md` — the why

The skills you read on-demand, not upfront.

## Cost and time

A full iteration runs every seed case through the pipeline and one focused
blue-team change. With the default architecture — local BGE embedder +
local BGE reranker + local Qwen prejudge for inner subset evals + Sonnet 4
as oracle for accept/revert decisions — expect **$0.50–$2 per iteration**
at N=50 cases once the response cache warms up.

`bratan.config.yaml` exposes `usd_per_run` and `tokens_per_iteration` as
hard ceilings; the loop aborts with `stop_reason="budget"` when hit.

## GPU recommended

The default stack is sized to fit on a 16 GB consumer GPU:
- Embedding: `BAAI/bge-large-en-v1.5` (~1.3 GB)
- Reranker: `BAAI/bge-reranker-v2-m3` (~2.3 GB)
- Prejudge: `Qwen/Qwen2.5-14B-Instruct-AWQ` (~9 GB, via vLLM)

Sonnet 4 is the oracle and always API. Local components are optional; the
setup wizard lets you flip each one to API if you prefer.
