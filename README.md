# Bratan — Self-Improving RAG That Actually Gets Better

> **A RAG only keeps getting better because it's a closed loop,
> between the thing that breaks it, the thing that fixes it, and the thing
> that scores it.** Bratan is the workspace where that loop runs.

Bratan is a self-improving Retrieval-Augmented
Generation framework built on an adversarial three-agent loop:
**Red Team** breaks the pipeline. **Blue Team** fixes it. **Judge** keeps the
score. They iterate against a co-evolving test set until your RAG converges
on something genuinely good — not just something that scores well on a static
benchmark.

You bring three things: **your corpus**, **your preferred vector DB**, and
**a handful of seed test cases** (authored through a polished UI that
validates each case against your corpus on the fly). Bratan owns everything
else — chunking, embedding, BM25, retrieval, reranking, prompts, generation,
citation verification, hyperparameters — and keeps making it better.

```
┌──────────────────────────────────────────────────────────────┐
│                       Your corpus                            │
│              (the only thing you must bring)                 │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│                       ⚙  Bratan loop                          │
│                                                              │
│   ┌────────────┐   ┌────────────┐   ┌────────────┐           │
│   │  RED TEAM  │──▶│ BLUE TEAM  │──▶│   JUDGE    │──┐        │
│   │  attacks   │   │   fixes    │   │   scores   │  │        │
│   └────────────┘   └────────────┘   └────────────┘  │        │
│         ▲                                            │        │
│         └────── new failure categories ──────────────┘        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│             ⚡ A tuned RAG pipeline you can deploy            │
└──────────────────────────────────────────────────────────────┘
```

---

## Why Bratan exists

### The premise everyone's working around

Production RAG systems in 2026 don't stop improving because the techniques
ran out. They stop improving because the *feedback loop* breaks. Someone
ships hybrid retrieval, the eval scores go up, the eval set stops moving,
and six months later the pipeline is overfit to the same fifty questions
the team wrote on a Tuesday in spring. The techniques accumulated; the
adversarial pressure didn't.

The only way a RAG keeps improving is a **closed loop** between three
things that don't trust each other:

1. an adversarial test-case generator that gets harder *because* the
   pipeline got better,
2. a hypothesis-driven engineer that changes one thing at a time and
   measures, and
3. a stable judge that won't grade itself.

So the central design question becomes:

> **How do you close the loop — red → blue → judge → red — so it keeps
> producing real improvement, instead of overfitting to a static eval?**

That's the question Bratan answers. Techniques (hybrid retrieval, query
rewriting, contextual enrichment, reranking, citation verification, etc.)
still accumulate as the loop runs — they live as `SKILL.md` files that the
blue team picks up on demand. But the accumulation is a *consequence* of
the loop, not the premise. The premise is the loop.

### Why existing approaches fall short

| Approach | What it offers | Why it falls down |
|---|---|---|
| **DSPy / MIPROv2** | "Compile a pipeline" framing | Search space fixed by the framework; can't reach changes the authors didn't expose |
| **RAGAS + LangSmith + GEPA + glue** | Best-in-class point tools | Four packages, four release cycles, four API surfaces. All the bugs live in your glue code. |
| **Plain LLM-as-judge harness** | Cheap to set up | Optimizes against a *static* eval; converges to a local optimum and stops improving |
| **Bratan** | Three agents reasoning at the level you care about (failure categories, hypotheses, structural changes) — backed by markdown skills that accumulate over time | You need to trust the judge. We've designed the loop assuming you do, and we instrument for drift. |

### What makes Bratan structurally different

- **Adversarial, not actor-critic.** A single agent that proposes and
  measures will overfit to a fixed eval. Bratan's Red Team's job is to make
  the test set *harder because the pipeline got better*. The test set keeps
  moving because the pipeline keeps moving.
- **The judge is a separate role on purpose.** If the blue team graded its
  own work, it would learn to grade leniently. If the red team graded the
  blue team, it would over-fail to justify its existence. The judge is the
  only stable ground truth.
- **Techniques live as markdown, not code.** Every RAG technique Bratan
  knows about is a `SKILL.md` file. New techniques become new files; the
  agents themselves stay thin. This matches Anthropic's own
  [`skills/`](https://github.com/anthropics/skills) pattern, the
  canonical agent-system idiom of 2026.
- **Your RAG, your DB, our optimizer.** A thin `VectorDBAdapter` is the
  only swap point. Bratan ships five functional adapters out of the box
  — ChromaDB, Qdrant, Pinecone, Weaviate, and pgvector — plus an
  **Other** option for any backend not in that list (subclass
  `VectorDBAdapter`, point the wizard at your module). Everything
  above that line is the Blue Team's playground.

---

## The three agents

### 🔴 Red Team — adversarial test generation

**Mission:** make the test set harder *as the pipeline gets better*, so the
Blue Team never gets to coast on cases it already handles.

**Workflow** (`agents/red-team/AGENTS.md`):

1. Read `/reports/latest.json`. What failure categories are
   *underrepresented* in the test set?
2. Sample 5–10 documents from the corpus. Look for parts of the corpus the
   current test set hasn't covered.
3. Generate 10 candidate cases, each targeting **one** specific failure
   category:
    - 🔤 **paraphrase brittleness** — answer exists but uses different terms
    - 🔗 **multi-hop** — answer requires combining 2+ documents
    - 📊 **structured content** — answer is in a table, list, or code block
    - 🕒 **temporal reasoning** — *"recent"*, *"last quarter"*, *"before X"*
    - 🚫 **negation / scope** — *"what doesn't X do"*, *"everything except Y"*
    - 🎯 **disambiguation** — multiple things with similar names
    - 🛑 **out-of-scope refusal** — answer is NOT in the corpus; should refuse
4. **Verify** each candidate by running `scripts/eval_single.py`. Keep
   only the ones that *actually fail* (composite < 0.6) and whose ground
   truth is verifiably in `/corpus/`.
5. Append verified failures to `/test_cases/generated/<timestamp>.jsonl`.

**Skills used:**
- [`synthetic-question-generation`](skills/synthetic-question-generation/SKILL.md)
  — adversarial generation strategies (multi-hop, paraphrase-distance,
  disambiguation, negation, temporal)
- [`failure-clustering`](skills/failure-clustering/SKILL.md) — read the
  current failure landscape before generating

### 🔵 Blue Team — hypothesis-driven engineering

**Mission:** fix the pipeline so it passes more cases *without regressing*
the ones it already passes. The Blue Team is a careful engineer, not a
tweaker.

**Workflow** (`agents/blue-team/AGENTS.md`):

1. Read `/reports/latest.json` + the last 3 runs from `/reports/history/`.
   Is the score trending up, flat, or down?
2. **Identify the largest failure cluster.** One root cause per
   invocation, not whack-a-mole on individual cases.
3. **Write down the hypothesis** before doing anything. *"The 8 failing
   multi-hop cases all involve comparing two product specs; the retriever
   returns one matching chunk but not both; query decomposition should
   help."*
4. **Read at most 2 relevant skills** — don't read all of them every time.
5. **Make ONE focused change.** Examples:
    - Swap the embedding model
    - Add a query-rewriting step
    - Change chunking strategy (fixed-size → recursive → semantic)
    - Add a BM25 lane and merge with RRF
    - Add a citation-verification post-pass
6. Run a full eval. If the change regresses any previously-passing case
   *and* doesn't recover the targeted failures, **revert.** Atomic
   commits, one per change, with rationale in `pipeline/CHANGELOG.md`.

**Skills used (typically one or two per invocation):**

*Pipeline-shape skills* — when the Blue Team is deciding **what to change**:
- [`rag-architect`](skills/rag-architect/SKILL.md) — high-level pipeline
  design and stage trade-offs
- [`hybrid-retrieval`](skills/hybrid-retrieval/SKILL.md) — BM25 + vector + RRF
- [`contextual-chunk-enrichment`](skills/contextual-chunk-enrichment/SKILL.md)
  — prepend LLM-generated context to chunks before embedding (Anthropic's
  contextual-retrieval idea)
- [`citation-verification`](skills/citation-verification/SKILL.md) —
  post-generation pass to catch invented citations
- [`failure-clustering`](skills/failure-clustering/SKILL.md) — diagnose
  *which* layer to change before deciding *what* to change

*Optimization-method skills* — when the Blue Team is deciding **how to
search the space of changes**:
- [`ablation`](skills/ablation/SKILL.md) — disable one stage at a time
  to attribute contribution. The first move for any mature pipeline,
  because stages accumulate and not all of them are still earning their
  keep on your corpus.
- [`grid-sweep`](skills/grid-sweep/SKILL.md) — exhaustive enumeration
  over 1–2 low-cardinality axes. Simpler than BO; surfaces the response
  shape, not just the optimum.
- [`bayesian-optimization`](skills/bayesian-optimization/SKILL.md) —
  sample-efficient search for 1–5 numeric parameters when the eval is
  expensive (TPE via Optuna by default). 10× fewer trials than random
  search; matters when each trial is N Sonnet 4 calls.
- [`particle-swarm`](skills/particle-swarm/SKILL.md) — for mixed
  continuous + discrete + categorical spaces with a rough response
  surface (e.g., when the embedding model is itself a tuning axis).
  Population-based, robust to discontinuities BO can't see across.

These compose: **ablate** first to factor the problem and identify which
parameters matter; **grid** to bound the productive region; then **BO**
or **PSO** inside that region depending on smoothness. Every search
runs the inner-loop trials on the local **prejudge** for cost
efficiency, then **oracle-validates** the winner with Sonnet 4 before
persisting the change to `pipeline/config.yaml`.

Skills are accumulative. When the Blue Team discovers a new technique
works, it authors a new `SKILL.md` and future iterations can reach for it.
**This is how the system gets smarter over time — not just better-tuned,
but better-equipped.**

### ⚖️ Judge — the only stable ground truth

**Mission:** evaluate every test case against the current pipeline and
write a structured report. The judge is **the load-bearing assumption of
the whole loop** — if it grades unreliably, the loop optimizes toward
noise.

**Three metrics per case:**
- **`retrieval_recall@5`** — fraction of the case's ground-truth passages
  in the top-5 retrieved chunks. Deterministic; no LLM call needed.
- **`answer_correctness`** — LLM compares generated answer to ground truth
  using a **fixed prompt at temperature 0**. Returns 0.0 / 0.5 / 1.0.
- **`faithfulness`** — LLM checks that every claim in the answer is
  supported by retrieved chunks (catches hallucinated citations). Also
  fixed-prompt, T=0, 0.0 / 0.5 / 1.0.

**Composite:** `0.4 · correctness + 0.3 · recall@5 + 0.3 · faithfulness`

**The prejudge / oracle split** (Bratan's cost-control trick): the loop
uses a *local* model (Qwen-14B via vLLM, on your GPU) as a **prejudge**
during inner-loop iterations — fast, free, fine for hypothesis-testing
sweeps. Every decision that *actually matters* — accept/revert a Blue Team
change, declare convergence, score a regression, emit a final report —
uses **Sonnet 4 as the oracle** at temperature 0. The prejudge is a
sample-efficiency tool, never a quality gate. CLAUDE.md's invariant — *the
judge that scores the report is never downgraded* — is preserved.

The judge also runs **drift checks**: periodically re-scores 5 random
historical `(case, answer)` pairs and flags itself in
`low_confidence_verdicts` if it disagrees with its prior self by more than
5%. The loop halts on `stop_reason: judge_drift` if drift persists across
three consecutive checks. The judge tells you when it can no longer be
trusted.

---

## How the loop runs

```
                          ┌─────────────────┐
                          │  bratan.config  │
                          │ (user-owned)    │
                          └────────┬────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
  │  test_cases/     │   │   /pipeline/     │   │    /corpus/      │
  │  seed.jsonl  +   │   │  (blue team's    │   │  (your docs)     │
  │  generated/      │   │   playground)    │   │                  │
  └──────────────────┘   └──────────────────┘   └──────────────────┘
            ▲                      ▲
            │  appends             │  one focused change per commit
            │                      │
            │                      │
   ┌────────┴─────────┐   ┌────────┴─────────┐   ┌──────────────────┐
   │   🔴 Red Team    │──▶│   🔵 Blue Team   │──▶│    ⚖️ Judge      │
   │ (Sonnet 4 + SDK) │   │ (Sonnet 4 + SDK) │   │  (Sonnet 4 T=0)  │
   └──────────────────┘   └──────────────────┘   └────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │   /reports/      │
                                                │  run-<ts>.json   │
                                                │  latest.json     │
                                                │  regressions.md  │
                                                └──────────────────┘
                                                          │
                                            7 stop reasons evaluated
                                                          │
                                          ┌───────────────┴─────────────┐
                                          ▼                             ▼
                                     STOP (reason recorded)    CONTINUE (next iter)
```

**Per iteration:**
1. Red Team appends new failures to `/test_cases/generated/`
2. Blue Team makes one focused change, commits with prefix `loop-iter-<n>:`
3. Judge runs `scripts/eval.py` — every case through the pipeline,
   per-case score with **oracle** Sonnet 4
4. `stop_criteria.evaluate()` checks **seven** stop conditions:
   `convergence` (the score plateaued) · `budget` (ran out of USD) ·
   `max_iterations` (hit the cap) · `anchor_regression` (a seed case
   dropped beyond threshold) · `judge_drift` (the judge stopped trusting
   itself) · `blue_stall` (three consecutive reverts) · `manual` (you
   pressed stop)
5. If any fires, the loop halts and records the `stop_reason` in the
   final report

---

## What "best practice 2026" looks like inside Bratan

| Practice | How Bratan does it |
|---|---|
| **Agents reason at the user-meaningful level** | Failure categories, hypotheses, structural pipeline changes — not API-specific search spaces |
| **Skills accumulate as markdown** | `SKILL.md` per technique; agents stay thin, can author new skills |
| **Temperature 0 + fixed grading prompts** | Determinism. The grading prompt cannot drift mid-run. |
| **Append-only test set + human-anchored ground truth** | Old cases never deleted. Every red-team case is verified against the corpus before it enters the loop. Regressions are hard failures. |
| **Atomic, reversible changes** | One change per commit. CHANGELOG documents rationale. `git revert` is a first-class outcome the Blue Team can use. |
| **Local prejudge + remote oracle** | 10–20× token savings on inner-loop iterations without compromising the judgment that actually decides things |
| **Hermetic per-iteration reports tied to code state** | Every report carries a `pipeline_manifest_hash` — you can map any score back to the exact code that produced it |
| **Multi-axis stop criteria** | Convergence is one of seven. Budget caps, anchor regressions, judge drift, and Blue Team stalls all halt the loop before it wastes resources |
| **Drift detection on the judge itself** | Periodic self-consistency checks; the judge tells you when it stops being trustworthy |
| **A polished UI for the only thing humans must do** | Authoring seed cases. FastAPI + Vite/React, with live corpus search, passage picker, and on-the-fly validation. Designed so non-technical authors can produce good cases. |

---

## Quickstart

```bash
# 1. Install
git clone https://github.com/AllanWessels/Bratan.git
cd Bratan
uv sync                           # Python deps
(cd ui/frontend && npm install)   # frontend deps

# 2. Drop your documents into /corpus/

# 3. Launch the UI (setup wizard + seed authoring)
make ui
# Backend:  http://127.0.0.1:8000
# Frontend: http://127.0.0.1:5173
```

The wizard walks you through 8 steps: project basics → vector DB → models
(Anthropic + local vLLM) → cost ceilings → seed-target *N* → GPU detection →
stopping criteria → judge weights. Auto-save per step.

Then you author seed cases against your corpus. Each case is **validated
on save** — the UI confirms the chosen passages are retrievable in
top-*k*, that your ground-truth answer text appears in those passages, and
optionally that the current pipeline produces something reasonable.

```bash
# 4. Index the corpus
uv run python pipeline/ingest.py

# 5. Baseline eval (no agents, just judge the current pipeline)
uv run python scripts/loop.py --iterations 0

# 6. Run the loop
uv run python scripts/loop.py --iterations 50 --budget-usd 10
```

A live dashboard streams per-iteration metrics; you can also browse the
reports under `/reports/`.

---

## Repo layout

```
CLAUDE.md             how to work in this repo (read first)
docs/RATIONALE.md     why the architecture looks like this
docs/RESUME-HERE.md   current state of the implementation
bratan.config.yaml    user-owned project config (setup wizard writes this)
/agents/              AGENTS.md specs for the three agents (thin)
  red-team/AGENTS.md
  blue-team/AGENTS.md
  judge/AGENTS.md
/agents/judge/prompts/   fixed grading prompts (humans edit, never agents)
/skills/              SKILL.md per technique — read on demand
  # pipeline-shape skills (what to change)
  rag-architect/                  high-level pipeline design
  hybrid-retrieval/               BM25 + vector + RRF
  contextual-chunk-enrichment/    Anthropic's contextual-retrieval idea
  failure-clustering/             diagnose which layer to change
  synthetic-question-generation/  adversarial test-case strategies
  citation-verification/          post-hoc grounding check
  # optimization-method skills (how to search the space of changes)
  ablation/                       attribute each stage's contribution
  grid-sweep/                     enumerate small Cartesian products
  bayesian-optimization/          sample-efficient search via TPE / GP
  particle-swarm/                 mixed continuous+discrete spaces
/pipeline/            blue-team's lane — the artifact being improved
  config.yaml         hyperparameters
  ingest.py           corpus → vector store
  query.py            the actual RAG function: question → answer
  judge.py            prejudge/oracle router (the load-bearing module)
  metrics.py          per-iteration report builder
  stop_criteria.py    the 7 stop conditions
  agent_runner.py     subprocess wrapper + config-snapshot guard
  adapters/           VectorDBAdapter (the swap point)
    base.py
    chroma.py             ← default, ships with M1
    qdrant.py / pinecone.py / weaviate.py / pgvector.py  ← functional
    (custom backends plug in via docs/custom-adapter.md)
  prompts/            generation + grading templates
  CHANGELOG.md        blue-team's rationale log
/test_cases/          append-only
  seed.jsonl          human-authored anchor cases
  generated/          red-team output, one timestamped JSONL per run
  schema.md           the canonical test-case shape
/corpus/              your documents
/reports/             judge writes here, all agents read
  latest.json
  history/
  regressions.md
/ui/                  setup wizard + seed authoring + live dashboard
  backend/            FastAPI app + services
  frontend/           Vite + React + TypeScript
/scripts/
  loop.py             orchestrator (red → blue → judge)
  eval.py             full-corpus eval; writes /reports/
  eval_single.py      single-case eval (red team uses this)
  serve_ui.py         dev launcher
/tests/               124 tests; ~3s combined
  test_judge.py            (13)
  test_metrics_and_stop.py (11)
  test_chroma_adapter.py   (9)
  test_qdrant_adapter.py   (13)
  test_pinecone_adapter.py (22)
  test_weaviate_adapter.py (20)
  test_pgvector_adapter.py (21)
  test_loop_orchestrator.py(9)
  test_ingest.py           (16)
  test_config_store.py     (15)
  test_agent_runner.py     (7)
  test_contract_smoke.py   (4)
  test_seed_workflow.py    (3)
  integration/
    test_ingest_query_pipeline.py  (4)
    test_eval_end_to_end.py        (1)
    test_api_acceptance.py         (2)
  + 31 frontend tests under ui/frontend/src/
```

---

## Metrics, every iteration

Every report under `/reports/run-<ts>.json` contains:

- **`composite`** — mean ± stdev of `0.4·correctness + 0.3·recall@5 + 0.3·faithfulness`
- **`per_category`** — composite broken down by `failure_category`
  (paraphrase, multi-hop, structured, temporal, negation, disambig,
  out-of-scope, straightforward)
- **`pass_rate_at_0_6`** — fraction of cases at or above the 0.6 cutoff
- **`regressions`** / **`recoveries`** — case IDs that crossed the 0.6
  threshold vs the prior report
- **`cost`** — `oracle_calls`, `prejudge_calls`, `cache_hits`,
  `usd_spent`, `tokens_in`, `tokens_out`
- **`latency`** — `p50` / `p95` for retrieval + generation + total
- **`pipeline_manifest_hash`** — SHA over `pipeline/**` + `config.yaml`
  (ties this report to the exact code that produced it)
- **`drift`** — `samples_checked`, `disagreement_rate`
- **`judge_weights_hash`** — detects mid-project weight changes that
  would invalidate comparability
- **`stop_reason`** — populated on the final report of a run

---

## Cost
`bratan.config.yaml` exposes `usd_per_run` and `tokens_per_iteration` as
hard ceilings; the loop aborts with `stop_reason: budget` when hit.

The default GPU stack fits on a 16 GB consumer card:
- Embedding: `BAAI/bge-large-en-v1.5` (~1.3 GB)
- Reranker: `BAAI/bge-reranker-v2-m3` (~2.3 GB)
- Prejudge: `Qwen/Qwen2.5-14B-Instruct-AWQ` (~9 GB)

Sonnet 4 is the oracle and always API. Every local component is
optional — the setup wizard lets you flip each one to API.

---

## Testing posture

Bratan ships with **~700 automated tests** across three layers, all gated
by CI on every PR.

| Layer | Tool | Tests | Files | LOC |
|---|---|---|---|---|
| Backend integration + unit | `pytest` | **260** | 25 | 5,783 |
| Frontend unit / actuation | `vitest` + Testing Library | **425** | 53 | 10,233 |
| Frontend end-to-end | `Playwright` (Chromium) | **15** | 9 | 1,759 |
| **Total** | — | **~700** | 87 | **17,775** |

For reference, production code is **13,765 LOC** (6,656 Python + 7,109
TypeScript), so the test:production line-count ratio is **~1.3 : 1** —
there's slightly more test code than production code.

### What the tests actually exercise

- **Cross-query invalidation tests** with a real `QueryClient` + stubbed
  HTTP layer — catches the "ingest succeeds but the UI still shows 'not
  ingested'" class of bug that mocked-hook unit tests structurally
  cannot see.
- **Observable persistence tests** that drive the same code path the
  user drives, no mocks at the layer where the bug lives. The regression
  test for the chroma chunk-count bug ingests a fixture corpus through
  the real subprocess worker, then calls `list_corpus()`, then asserts
  `ingested: true` — round-trip, no shortcuts.
- **Subprocess isolation tests** that exercise `BRATAN_CHROMA_SUBPROCESS_QUERY=1`
  mode explicitly and verify the worker resolves `scripts.query_worker`
  under pytest (where `BRATAN_PROJECT_ROOT` is a tmpdir).
- **Pytest isolation guards** — a session-wide autouse fixture
  fingerprints `./.chroma/chroma.sqlite3` at test start and FAILS any
  test that mutates it, plus a production-code guard refuses to open the
  default `.chroma` path when `PYTEST_CURRENT_TEST` is set. This stops
  the test suite from silently corrupting state across sessions.
- **Real-error paths** — tests assert the *verbatim error string* the
  user sees ("the tenant 'corpus' does not exist") rather than a
  generic "validation failed" stub. The errors users hit are the errors
  the tests check.
- **Pre-handoff 11-item checklist** — every state-changing session ends
  with a numbered checklist of real `curl` / `ls` commands proving the
  app is in a clean state before handing off. Documented in `CLAUDE.md`.

### Open prod gaps the tests intentionally reveal

Four `it.fails()` tests in `vitest` document real prod bugs the audit
surfaced but the team hasn't fixed yet — they're known-failing-on-purpose
so they don't slip back into "we forgot about that":

| Failing test | Prod gap |
|---|---|
| `Authoring.modetab.test.tsx` (×2) | Mode-tab switch silently drops in-flight drafts |
| `Run.reconnect.test.tsx` | No reconnect indicator when websocket drops mid-loop |
| `Settings.test.tsx` cross-section persistence | Sidebar nav drops typed-but-unsaved field values |

When each gets fixed in prod, flip `it.fails` → `it` and the test
becomes a regression guard automatically.

See `docs/ui-coverage-audit-2026-05-24.md` for the full coverage matrix
(481 lines) that drove this testing work.

---

## What Bratan deliberately does *not* do

- **No fine-tuning.** Every improvement happens at the prompt,
  configuration, and pipeline-code level. If you hit this approach's
  ceiling, fine-tune separately — we don't want loop iterations
  bottlenecked on training.
- **Not a production service.** Bratan is an *optimization workspace*.
  Once your pipeline is good, you deploy `pipeline/query.py` however you
  want.
- **No web-scale multi-tenancy.** Real production RAG needs per-user
  permission filtering at retrieval time. The optimization loop is
  single-tenant — add ACLs when you deploy.
- **No wrapping of LangChain / LlamaIndex / DSPy.** Those are fine; they
  just aren't the abstraction Bratan uses. If a technique from those
  libraries belongs here, capture it as a `SKILL.md`.

---

## The fragility worth watching for

The judge is the load-bearing assumption. If LLM-as-judge ever drifts
substantively, the whole project's correctness collapses. Bratan mitigates
this three ways:

1. **Temperature 0 + fixed grading prompts.** The grading prompt cannot
   be edited by any agent — only by humans, between runs, never during.
2. **Periodic drift checks.** The judge re-grades 5 random historical
   pairs every few iterations and logs disagreement.
3. **Human-anchored ground truth.** Every test case carries a
   human-verified source passage. The judge has something to compare
   against rather than inventing standards.

If drift persists across three checks, the loop halts with
`stop_reason: judge_drift`. The system tells you to look.

---

## How Bratan was built — collaboration skills

Bratan was built across a long pair-programming session with Claude. The
assistant accumulated a set of **meta-skills** along the way — patterns
for collaborating on hard codebases — that are NOT RAG techniques and
NOT specific to Bratan. They live at [`docs/build-skills/`](docs/build-skills/)
as a snapshot, and at `~/.claude/skills/` as the live source for the
human's other projects.

Distinct from [`/skills/`](skills/) (which captures the RAG techniques
the red and blue teams use *inside* the loop), these 10 skills capture
how the **outside** of the loop was built without slipping into
"works on my machine" or whack-a-mole bug fixing:

| Skill | What it captures |
|---|---|
| [`parallel-fanout-verification`](docs/build-skills/parallel-fanout-verification/SKILL.md) | Dispatch test layers + independent fixes as parallel sub-agents |
| [`fix-first-then-test`](docs/build-skills/fix-first-then-test/SKILL.md) | Harness is verifier, not debugger — land fixes before running |
| [`verifier-state-vs-user-state`](docs/build-skills/verifier-state-vs-user-state/SKILL.md) | Process-restart + round-trip after every verifier run |
| [`subprocess-isolation-for-process-state-clients`](docs/build-skills/subprocess-isolation-for-process-state-clients/SKILL.md) | Both read AND write through subprocess for chromadb-class clients |
| [`observable-outcome-tests-over-mocks`](docs/build-skills/observable-outcome-tests-over-mocks/SKILL.md) | Assert visible state changes, not call counts |
| [`pre-handoff-clean-state-proof`](docs/build-skills/pre-handoff-clean-state-proof/SKILL.md) | Numbered checklist of real commands, not "I think it's clean" |
| [`audit-then-fanout-fix`](docs/build-skills/audit-then-fanout-fix/SKILL.md) | Coverage matrix → fan-out one fix agent per gap class |
| [`agent-model-selection`](docs/build-skills/agent-model-selection/SKILL.md) | Pass `model:` explicitly on every Agent dispatch |
| [`api-rewrite-sweep`](docs/build-skills/api-rewrite-sweep/SKILL.md) | An API-change commit MUST sweep every consumer test in the same commit |
| [`ci-vs-dev-environment-parity`](docs/build-skills/ci-vs-dev-environment-parity/SKILL.md) | "Works on my machine" has 3 predictable origins: gitignored fixtures, dev-only ports, dev-only env vars |

The last two emerged from the post-merge CI loop — every push found a
new way for the local environment to lie about what CI would actually
do. Each skill names the failure mode, the concrete fix recipe, and
the anti-patterns the rule exists to prevent.

These are not aspirational. The 4 top-level `⚡ OPERATING PRINCIPLE`
blocks at the top of `CLAUDE.md` are the load-bearing four, encoded as
hard rules because each one was learned the painful way during this
build.

---

## Influences

None of these are dependencies — they're the conceptual ancestors:

- **Anthropic's contextual retrieval paper** — the chunk-enrichment idea
- **GEPA** — the genetic-Pareto prompt optimization paper; "search with
  reflection"
- **DSPy / MIPROv2** — the "compile a pipeline" framing
- **Anthropic's [`skills/`](https://github.com/anthropics/skills) repo**
  — the SKILL.md format itself
- **Microsoft's BlueCodeAgent** — red-team/blue-team architecture applied
  to a structurally identical problem in code synthesis
- **RAGAS** — synthetic test generation via evolutionary mutation

---

## Reading order for a new collaborator

1. `CLAUDE.md` — orientation
2. `docs/RATIONALE.md` — the deeper *why* behind every design choice
3. `agents/judge/AGENTS.md` — the simplest agent, helps build intuition
4. `agents/blue-team/AGENTS.md` — the improvement engine
5. `agents/red-team/AGENTS.md` — the adversarial generator
6. `docs/RESUME-HERE.md` — what's built, what's open, the demo recipe

Skills you read **on demand**, not upfront. The system is designed so you
never need to hold all of it in your head at once.

---

## License

Apache-2.0. PRs welcome, especially for new `SKILL.md` files.
