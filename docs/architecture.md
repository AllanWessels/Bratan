# Architecture

This document is the day-two reference for how Bratan's pieces fit together.
For the *why* behind the architecture, read `docs/RATIONALE.md` once.
For the *what* — the runtime data flow, the lane boundaries, the on-disk
formats, the load-bearing invariants — start here.

## Data flow

```
       ┌─────────────┐
 user →│  setup UI   │── writes ──▶ bratan.config.yaml
       │  (wizard)   │              .bratan-setup.json
       └──────┬──────┘
              │ also writes
              ▼
      test_cases/seed.jsonl   (authoring UI, human-anchor cases)
              │
              ▼
      ┌──────────────────────────────────────────────────┐
      │ scripts/loop.py   (orchestrator, one iteration)  │
      │   1. red-team  → test_cases/generated/<ts>.jsonl │
      │   2. blue-team → edits /pipeline/                │
      │   3. judge     → reports/run-<ts>.json           │
      │                  (and reports/latest.json)       │
      └─────────────┬────────────────────────────────────┘
                    │ append + atomic write
                    ▼
              /reports/  ◀─── /api/reports/{latest,history,<ts>}
                    │
                    ▼
           dashboard (Run.tsx)   ── click point ─▶  RunReportDetail.tsx
                    │
                    │ WebSocket   /api/loop/stream
                    └─────────────────────────────┐
                                                  │
                                          ui/backend (FastAPI)
                                          spawns loop subprocess via loop_control.py
```

Three things to notice:

1. **The UI never talks to the loop directly.** It writes config + seed
   cases, then asks the FastAPI backend (`ui/backend/app.py`) to spawn
   `scripts/loop.py`. The backend streams iteration completions over
   WebSocket by tailing `reports/latest.json`'s mtime.
2. **All cross-process state is files.** No queues, no shared memory.
   Reports, seed cases, generated cases, and config all live on disk
   under predictable paths.
3. **The vector store is the one external piece.** The five built-in
   adapters (Chroma / Qdrant / Pinecone / Weaviate / pgvector) and the
   "Other" slot all implement the same `VectorDBAdapter` ABC.

## The three lanes

Each agent has a strict on-disk lane. The orchestrator and the snapshot
guard enforce them.

| Agent     | Writes to                                  | Reads from                          |
|-----------|--------------------------------------------|-------------------------------------|
| Red team  | `test_cases/generated/<ts>.jsonl`          | `reports/latest.json`, `/corpus/`   |
| Blue team | `/pipeline/` (code, prompts, config.yaml)  | `reports/`, `/test_cases/`, skills  |
| Judge     | `reports/run-<ts>.json`, `reports/latest.json`, `reports/regressions.md` | `/test_cases/`, pipeline output |

Crossing a lane breaks regression guarantees and is reverted by the
snapshot guard or rejected by the orchestrator. Detail:

- **Blue team is *not* allowed to touch `bratan.config.yaml`, `/test_cases/seed.jsonl`, or `/corpus/`.** Those are the anchor.
- **Red team's generated cases need ground truth that exists in `/corpus/`.** The orchestrator verifies this before merging the new shard.
- **The judge runs with a frozen prompt + temperature 0** so it never co-evolves with the pipeline it's grading.

## The two configs

Bratan has two configuration files, and they're kept rigorously separated:

| File                       | Owner               | Purpose                                                       |
|----------------------------|---------------------|---------------------------------------------------------------|
| `bratan.config.yaml`       | **User** (setup UI) | which vector DB, which models, USD cap, stop criteria         |
| `pipeline/config.yaml`     | **Blue team**       | chunk size, retrieval `k`, reranker on/off, prompt switches   |

The blue team is allowed to edit anything under `/pipeline/` including
its `config.yaml`. It is *never* allowed to edit `bratan.config.yaml`.
Enforcement lives in `pipeline/agent_runner.py::config_snapshot_guard()`:
it snapshots both `bratan.config.yaml` and `.bratan-setup.json` before
invoking the agent, then byte-compares them after the agent exits. Any
divergence is reverted, logged, and surfaced as `config_was_mutated:
true` in the agent run record.

This split exists because the user is configuring their *environment*
(what infrastructure am I willing to pay for, what's my Anthropic key)
while the blue team is tuning the *pipeline* (what techniques does the
RAG itself use). Conflating them lets agents drift into "fix" the
budget when scores plateau — exactly the wrong adaptation.

## The cache + budget plane

Two small modules sit underneath the judge and the pipeline and shape
every iteration's cost profile:

- **`pipeline/cache.py`** — disk-backed LLM response cache keyed on
  `sha256(model | prompt | temperature)`. Lives at
  `.cache/llm/<2-hex-prefix>/<full-hash>.json`. Writes are atomic via
  `tempfile + os.replace` so a crash mid-write cannot corrupt entries.
  Callers opt in explicitly (`pipeline.judge` and `pipeline.query`
  wrap their own `_call_anthropic` / `_call_vllm` helpers); nothing
  monkey-patches or auto-injects.
- **`pipeline/budget.py`** — pure data structure tracking USD per
  iteration. Sonnet 4 list prices are baked in; local prejudge calls
  count as $0. The loop reads `budget.snapshot()` at the end of every
  iteration and aborts (`stop_reason: budget`) when the user's
  `cost.usd_per_run` ceiling is crossed.

These interact with the **prejudge / oracle split**: the local prejudge
model (Qwen via vLLM by default) is used for the cheap pass on every
case; only cases below the confidence threshold escalate to the
Anthropic oracle. Because *all* outputs flow through the cache, a
re-run with no pipeline changes is effectively free — a property the
loop's convergence detector relies on.

## The vector-store plane

The pipeline interacts with vector storage through exactly one
interface: `pipeline.adapters.base.VectorDBAdapter`. It exposes
`upsert(chunks)`, `query(embedding, k)`, `delete(ids)`, and a
`test_connection()` health check. Blue team writes against this ABC
and never imports a concrete backend.

Five built-in adapters ship today:

| Adapter   | Local?  | When to pick it                                                  |
|-----------|---------|------------------------------------------------------------------|
| Chroma    | yes     | default; zero-setup development                                  |
| Qdrant    | either  | hybrid (sparse + dense) on a self-host or Qdrant Cloud           |
| Pinecone  | hosted  | managed service, large corpora                                   |
| Weaviate  | either  | multi-tenant or built-in modules (text2vec, generative-search)   |
| pgvector  | local   | already on Postgres; want vectors next to your relational data   |

The **"Other" slot** is a configured Python import. The user supplies
`other_adapter_module` and `other_adapter_class` in
`bratan.config.yaml`; the factory imports it at runtime and treats it
identically. The contract is documented in `docs/custom-adapter.md`.

## Persistence formats

- **`test_cases/seed.jsonl`** — one JSON object per line, human-authored, append-only. Fields per `test_cases/schema.md`. Never modified by agents.
- **`test_cases/generated/<ts>.jsonl`** — one shard per red-team run. Same schema as seed plus `created_by: "red-team"` and `hypothesis`. Append-only.
- **`reports/run-<YYYY-MM-DDTHH-MM-SS>.json`** — full `IterationReport` (composite, per-case scores, regressions, cost, drift, latency). The filename normalizes `:` and `.` in the ISO timestamp so it's safe across filesystems.
- **`reports/latest.json`** — a copy of the most recent `run-*.json`. The WebSocket stream watches its mtime to detect new iterations.
- **`reports/regressions.md`** — human-readable rollup that surfaces stable regressions across iterations.
- **`.chroma/`** — Chroma's on-disk layout (one `chroma.sqlite3` plus an HNSW segment directory per collection). Other adapters use their own native stores; the `.chroma` directory is irrelevant if you pick a non-Chroma adapter.
- **`.cache/llm/`** — see "The cache + budget plane" above.

## Operating notes

- **Fan-out.** `scripts/eval.py` parallelizes across cases via a thread pool. The default is conservative because Anthropic rate limits bite at higher concurrency; bump it via `--workers` only after the cache is warm.
- **Never downgrade the judge.** The judge model is `claude-sonnet-4-6` and stays there. If the judge gets cheaper, the whole loop's load-bearing assumption (a stable grader) becomes questionable. This is the single hardest rule in the project.
- **The test set is append-only.** Old cases never get deleted or rewritten by agents. A regression on a case the previous iteration passed is a *hard* signal — not noise to be smoothed away.
- **`stop_reason` is authoritative.** When the loop stops, the reason is recorded on the final `IterationReport` and rendered as a badge in the dashboard. The seven reasons (`convergence`, `budget`, `max_iterations`, `anchor_regression`, `judge_drift`, `blue_stall`, `manual`) cover every shutdown path; if you're adding a new one, also extend `pipeline/stop_criteria.py` and `STOP_REASONS` in `ui/frontend/src/api/types.ts`.
- **The dashboard never mutates state.** It only reads (`/api/reports/*`), starts/stops the loop, and streams iteration completions. Clicking a point on the composite chart opens `/run/reports/<timestamp>`, which is a read-only pretty-printed view of the full `IterationReport` for that iteration.

For day-to-day "where do I read X / write Y" lookups, also check the table in `CLAUDE.md` under *Common situations and what to do*.
