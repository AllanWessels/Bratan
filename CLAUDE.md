# RAG Refiner

A self-improving RAG pipeline that gets better automatically through a
red-team / blue-team / judge agent loop, with techniques captured as skills.

> ## ⚡ OPERATING PRINCIPLE — VERIFY CLEAN STATE BEFORE HANDOFF
>
> **Before telling the user "ready, go retest", PROVE the state is clean.
> Never guess. Run the actual commands and read the actual output.**
>
> Required pre-handoff checklist — every item must be confirmed by a real
> command, not assumed:
>
> 1. `curl http://127.0.0.1:8000/api/health` → 200 + `{"ok":true}`
> 2. `curl http://127.0.0.1:8000/api/setup/state` → `config_exists: false,
>    setup_completed: false, completed_steps: []`
> 3. `curl -I http://127.0.0.1:5173/` → 200
> 4. `test -e bratan.config.yaml && echo STILL || echo gone` → `gone`
> 5. `test -e .bratan-setup.json && echo STILL || echo gone` → `gone`
> 6. `test -e .chroma && echo STILL || echo gone` → `gone`
> 7. `test -e test_cases/seed.jsonl && echo STILL || echo gone` → `gone`
> 8. `ls test_cases/.drafts/ test_cases/generated/` → empty (or only README)
> 9. `ls reports/run-*.json reports/latest.json 2>&1` → "No such file"
> 10. **Vite HMR currency check**: `curl -sS http://127.0.0.1:5173/src/<a
>     recently-changed component>.tsx | head -5` matches the on-disk file.
>     The user has been bitten by stale Vite modules; if served bytes
>     differ from disk, restart Vite: `pkill -f "node.*vite"; npm run dev
>     -- --port 5173 --host 127.0.0.1 &`.
> 11. Chroma query round-trip: `curl -sf POST /api/corpus/search` with a
>     one-token query must return HTTP 200, not 500. Repeats after
>     pkill+restart. This catches stale in-memory clients that disk wipes
>     don't clear.
>
> If ANY check fails, fix it before handing off. Saying "I think the state
> is clean" is exactly the failure mode this rule exists to prevent.

> ## ⚡ OPERATING PRINCIPLE — FIX FIRST, THEN TEST
>
> **Land every fix before running the test harness. NEVER ship code with
> the goal of "let's see what the tests say" — that wastes the test
> harness as a slow debugger and burns context on noisy failure logs from
> bugs you already know about.**
>
> The order is always:
>
> 1. **Reproduce** the user's report in your head from the code.
> 2. **Fix** the bug — all fixes for a logical unit go in together.
>    Within this phase, fan out: separate agents for separate bugs, in
>    parallel, on the same branch.
> 3. **Run the harness** (pytest + vitest + Playwright + live integration)
>    only after all in-flight fixes are committed. Fan out the harness
>    too — never sequential.
> 4. **Act** on harness reports. If they show a new bug, GOTO 2.
>
> The corollary: the harness is a verifier, not a debugger. Use `read` +
> `grep` to debug; reserve test runs for proving a fix actually works.

> ## ⚡ OPERATING PRINCIPLE — FAN OUT, ALWAYS
>
> **Default to parallel. Serial is the exception that requires
> justification.**
>
> Every task that can be split MUST be split. Dispatch sub-agents via the
> Agent tool with `run_in_background: true` for:
>
> - **Test runs** — pytest, vitest, Playwright, live ingest checks all in
>   parallel. Never run them one-by-one in the main session.
> - **Multi-component changes** — backend + frontend + tests as separate
>   agents on a shared contract.
> - **Verification cycles** — one agent per claim. Live-UI verifier,
>   static-test verifier, audit verifier, fix agent — all at once.
> - **Bug investigations** — a fix agent AND a verifier agent run in
>   parallel; the fix may land before the verifier reports, or vice versa.
>
> The main conversation context is finite. Log spam from torch / chromadb /
> vite fills it fast, and the user has been bitten by "I'll just do this
> in-line" multiple times. **NEVER test your own code** — always dispatch a
> verifier agent against a live system. Never claim a fix is shipped until
> a verifier agent confirms it works in the real browser / real backend.
>
> If you find yourself running ONE thing at a time, you are doing it wrong.
> Ask: "what could be running alongside this RIGHT NOW?" and dispatch it.

> ## ⚡ VERIFIER STATE ≠ USER STATE
>
> The verifier resets state for its own run cycle. The user does not. When
> verifier and user share the same uvicorn process, every bit of in-memory
> state poisoning the verifier creates flows straight to the user's next
> session — and "passing tests" mean nothing.
>
> **End every verifier run with these steps, in order:**
> 1. `rm -rf .chroma bratan.config.yaml` — disk wipe
> 2. `pkill -9 -f "uvicorn.*ui.backend.app"` — kill the FastAPI process so
>    no chromadb in-memory client survives
> 3. Restart uvicorn fresh
> 4. `curl -sf http://localhost:8005/api/corpus/search -d '{"query":"x","k":1}' -H "Content-Type: application/json"` — round-trip must return 200 (not 500), even with empty corpus
>
> Do not hand back control to the user until step 4 returns 200. The
> "no such table: tenants/databases" and "Nothing found on disk" errors
> are all the same root cause: a stale chromadb client surviving a disk
> wipe. The only reliable fix is process-level restart.

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
6. **Fan out.** See the FAN OUT OPERATING PRINCIPLE at the top of this file.

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
- Embedding model: `BAAI/bge-small-en-v1.5` (local, GPU if available;
  configurable in the setup wizard)
- Reranker: `BAAI/bge-reranker-v2-m3` (local; configurable)
- Pre-judge: `Qwen/Qwen2.5-7B-Instruct-AWQ` via local vLLM (configurable)
- Vector store: ChromaDB (local, no external service); Qdrant/Pinecone/
  Weaviate/pgvector adapters also ship
- Test set: starts at ~50 cases in `seed.jsonl`; grows from there
- Source of truth for these defaults is `ui/backend/schemas.py::ModelConfig`,
  not this list — if they ever diverge, the schema wins.

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
| Understanding how the pieces fit together | `docs/architecture.md` |

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
