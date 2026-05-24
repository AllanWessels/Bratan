# RAG Refiner

A self-improving RAG pipeline that gets better automatically through a
red-team / blue-team / judge agent loop, with techniques captured as skills.

## What this project is

This is not a wrapper around an existing RAG library. It is a workspace where
three agents iteratively improve a RAG pipeline against a co-evolving test
set. The pipeline itself lives at `/pipeline/` and starts simple; the agents
make it better.

The architecture in one paragraph: a **red team agent** generates test cases
the current pipeline fails on. A **blue team agent** edits the pipeline to
fix those failures without regressing previously-passing cases. A **judge
agent** runs the pipeline against all test cases and writes structured
reports. An orchestrator script invokes them in a loop. All three agents are
specified as `AGENTS.md` files; their shared knowledge of RAG techniques
lives as `SKILL.md` files in `/skills/`. Nothing is imported as a library
beyond standard tools (the vector store, the embedding model, the LLM API).

## Repo layout

```
CLAUDE.md                       you are here
README.md                       human-facing setup
pyproject.toml                  uv-managed Python project
.env.example                    required env vars

/agents/                        agent specifications
  red-team/AGENTS.md            who the red team is and what it does
  blue-team/AGENTS.md           who the blue team is and what it does
  judge/AGENTS.md               who the judge is and what it does

/skills/                        reusable techniques (read as needed)
  rag-architect/SKILL.md        high-level RAG design knowledge
  hybrid-retrieval/SKILL.md     BM25 + vector + RRF
  contextual-chunk-enrichment/SKILL.md   pre-embedding chunk context
  failure-clustering/SKILL.md   group failures by root cause
  synthetic-question-generation/SKILL.md adversarial test-case generation
  citation-verification/SKILL.md  post-hoc check that citations support claims

/pipeline/                      the thing being improved (blue team writes here)
  config.yaml                   chunk size, k values, model choices
  ingest.py                     loads /corpus/ into the vector store
  query.py                      the actual RAG function: question -> answer
  prompts/                      generation and rewrite prompts
  CHANGELOG.md                  blue team appends rationale per change

/test_cases/                    test set (red team writes here, judge reads)
  seed.jsonl                    initial human-authored test cases
  generated/                    red team adds new failures here
  schema.md                     test case format reference

/corpus/                        the documents the pipeline answers from
  README.md                     describes what's in here

/reports/                       judge writes here, red+blue read
  latest.json                   most recent full evaluation
  history/                      timestamped past runs
  regressions.md                surfaced regressions for human review

/scripts/
  loop.py                       the orchestrator (red -> blue -> judge)
  eval.py                       run pipeline against test cases
  eval_single.py                run one test case (used by red team)
```

## How to work in this repo

1. **Start by reading `/agents/<agent>/AGENTS.md`** when invoked as one of the
   three agents. That file is authoritative for that agent's behavior.
2. **Reach for skills as needed.** Each skill's `SKILL.md` says when to use
   it and when not. Don't read all skills upfront; let the task drive it.
3. **Modify in your own lane.** Red team writes to `/test_cases/generated/`.
   Blue team writes to `/pipeline/`. Judge writes to `/reports/`. Crossing
   lanes breaks the loop's guarantees.
4. **Commit per change with a rationale.** Every commit message starts with
   why, not what. The agents read each other's commit messages as signal.
5. **Never modify `/corpus/` or `/test_cases/seed.jsonl`.** These are the
   anchor. If those move, regression detection becomes meaningless.

## Run the loop

```bash
# One pass: red generates failures, blue fixes them, judge scores
uv run python scripts/loop.py --iterations 1

# Continuous loop until convergence (overnight runs)
uv run python scripts/loop.py --iterations 50 --converge-threshold 0.02
```

The loop converges when overall judge score improves by less than the
threshold across 5 consecutive iterations.

## Important defaults

- LLM for agents: Claude Sonnet 4 (model id `claude-sonnet-4-6`)
- LLM for judge: Claude Sonnet 4 (DO NOT downgrade — judge reliability
  is the load-bearing assumption of the whole loop)
- Embedding model: Voyage `voyage-3` (configurable in `/pipeline/config.yaml`)
- Vector store: ChromaDB (local, no external service)
- Reranker: `cohere/rerank-3.5` by default (configurable)
- Test set: starts at ~50 cases in `seed.jsonl`; grows from there

## The non-negotiable invariants

These exist because the loop's correctness depends on them. The agents are
told the same in their AGENTS.md files. Do not work around them.

1. **The judge's grading prompt does not change during a run.** If the judge
   gets to grade itself, the loop optimizes for whatever the judge happens
   to think today.
2. **Test cases are append-only.** Old test cases never get deleted or
   modified by agents. A regression on an old case is a hard failure.
3. **Pipeline changes are atomic.** One change per commit. The blue team
   reverts if a change regresses anything previously passing.
4. **Ground truth is human-authored.** The red team can propose new test
   cases, but their expected answers must come from `/corpus/` — the red
   team verifies the answer is *in* the corpus before adding the case.
5. **The judge runs at temperature 0 with a fixed prompt.** Determinism
   matters more than nuance at the judge layer.

## Common situations and what to do

| Situation | Read |
|---|---|
| Setting up the project for the first time | `README.md`, then `/pipeline/config.yaml` |
| Running as the red team agent | `/agents/red-team/AGENTS.md` |
| Running as the blue team agent | `/agents/blue-team/AGENTS.md` |
| Running as the judge agent | `/agents/judge/AGENTS.md` |
| Adding a new optimization technique | Author a new `/skills/<name>/SKILL.md` |
| Diagnosing why scores plateaued | `/reports/regressions.md`, then failure clustering skill |
| Debugging a single bad answer | `/scripts/eval_single.py` with the case ID |

## What this project deliberately does not do

- It does not wrap LangChain, LlamaIndex, or DSPy. Those are fine; they're
  just not the abstraction this project uses. If a technique from those
  libraries belongs here, capture it as a skill.
- It does not run a web service. It is a local optimization workspace. Once
  you have a good pipeline, you deploy `/pipeline/query.py` however you want.
- It does not retrain models. All improvements happen at the prompt,
  configuration, and pipeline-code level. If you find yourself wanting to
  fine-tune, that's a signal you've hit this approach's ceiling.

## Background

The conceptual basis for this project is captured in `docs/RATIONALE.md`,
which traces why the architecture looks the way it does (the short version:
a RAG only keeps improving when there's a closed feedback loop between an
adversarial test generator, a hypothesis-driven engineer, and a stable
judge; the right architecture is one that closes that loop and lets the
agents accumulate techniques as markdown as a side effect). Read it once
before making structural changes; you don't need it day-to-day.
