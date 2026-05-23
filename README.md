# RAG Refiner

A self-improving RAG pipeline. Three agents — red team, blue team, judge —
iterate against a co-evolving test set until the pipeline converges on
high quality.

## What's in this repo

```
CLAUDE.md          orientation for Claude Code; read first
docs/RATIONALE.md  why the architecture looks like this
/agents/           AGENTS.md specs for the three agents
/skills/           SKILL.md files capturing reusable techniques
/pipeline/         the thing being improved (starts simple)
/test_cases/       seed.jsonl + agent-generated cases
/corpus/           your documents (you provide these)
/reports/          judge writes here, others read
/scripts/          orchestrator and eval runners
```

## Quickstart

```bash
# 1. Clone, install
git clone <this-repo>
cd rag-refiner
uv sync

# 2. Configure
cp .env.example .env  # add ANTHROPIC_API_KEY, VOYAGE_API_KEY
# Drop your documents into /corpus/

# 3. Write 20-50 seed test cases in /test_cases/seed.jsonl
#    See /test_cases/schema.md for the format

# 4. Index the corpus
uv run python pipeline/ingest.py

# 5. Baseline evaluation
uv run python scripts/loop.py --iterations 0  # judge-only

# 6. Run the improvement loop
uv run python scripts/loop.py --iterations 20
```

## What "done" looks like

The loop converges when the overall composite score plateaus — five
consecutive iterations with <2% improvement. At that point your pipeline
in `/pipeline/query.py` is the artifact to deploy.

## Reading order if this is your first time

1. `CLAUDE.md` — system orientation
2. `/agents/judge/AGENTS.md` — the simplest agent, helps you understand the loop
3. `/agents/blue-team/AGENTS.md` — the improvement agent
4. `/agents/red-team/AGENTS.md` — the adversarial agent
5. `docs/RATIONALE.md` — the why

The skills you read on-demand, not upfront.

## Cost and time

A full loop iteration runs all test cases through the pipeline once and
makes one pipeline change. With 100 test cases and Claude Sonnet 4 as
both pipeline LLM and judge, expect ~$3-8 per iteration and ~10-30
minutes of wall time. Run overnight for ~30 iterations.

If you want to cut cost, swap in a local model for the pipeline's LLM
(not the judge) — see CLAUDE.md "Important defaults".
