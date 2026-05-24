# Metrics — what every iteration report contains

> Authoritative source: the Pydantic models in
> [`/pipeline/metrics.py`](../pipeline/metrics.py). This page is the prose
> companion — it explains what each field *means*, how it's computed, what
> range to expect, and what blue-team or judge behavior should change if it
> looks wrong.

## Overview

Every pass of `scripts/loop.py` (one red → blue → judge cycle, or a
`--no-agents` eval-only iteration) writes a structured **`IterationReport`**
to `reports/run-<timestamp>.json`, mirrors it to `reports/latest.json`, and
copies it under `reports/history/`. Reports are append-only and immutable.
Their job is twofold: (1) be the shared source of truth the three agents
read between turns, and (2) make every score in the project's history
*reconstructible* — every report carries a `pipeline_manifest_hash` and a
`judge_weights_hash`, so you can tie any number back to the exact code and
weights that produced it.

A complete report is a small JSON object (~10 KB for an N=50 test set). It
has the same shape regardless of whether the iteration ran the agents or
just re-scored the existing pipeline — fields that don't apply (e.g.
`regressions` on the very first iteration) default to empty.

Sections below cover every field in `IterationReport` and its sub-blocks.

---

## `composite_mean` / `composite_stdev`

```text
composite_mean  : float in [0.0, 1.0]
composite_stdev : float >= 0.0
```

The headline numbers. Each test case gets a **composite score** from the
judge:

```
composite = w_correctness  * answer_correctness
          + w_recall        * retrieval_recall@5
          + w_faithfulness  * faithfulness
```

with default weights `0.4 / 0.3 / 0.3` (see `bratan.config.yaml →
judge_weights`). `composite_mean` is the unweighted arithmetic mean over
all cases in the run; `composite_stdev` is the sample standard deviation
(only meaningful when more than one case was scored — it returns `0.0` for
a single-case run).

**How to read it.** Trend over consecutive iterations is the signal: a
flat or downward `composite_mean` over three iterations is what triggers
`stop_reason: blue_stall`. A *large* `composite_stdev` (>0.2 say) means
the pipeline is bimodal — it nails some cases and faceplants on others.
That's a hint for the blue team to look at `per_category` and pick a
single failure cluster rather than tune globally.

**When `composite_stdev` matters most.** During Bayesian-optimization or
particle-swarm sweeps. A change that lifts `composite_mean` but also
spikes `composite_stdev` is suspicious — it's probably winning on a few
cases by sacrificing others.

---

## `per_category`

```text
per_category : dict[str, CategoryStats]
  CategoryStats:
    count          : int >= 0
    avg_composite  : float in [0.0, 1.0]
    pass_rate      : float in [0.0, 1.0]
```

The composite broken down by `failure_category`. Categories come from
[`/test_cases/schema.md`](../test_cases/schema.md) and are exactly:

- `paraphrase_brittleness`
- `multi_hop`
- `structured_content`
- `temporal_reasoning`
- `negation_or_scope`
- `disambiguation`
- `out_of_scope`
- `straightforward`

Only categories that have at least one case in the current test set
appear — the dict is sparse, not dense across all eight.

**How to read a per-category miss.** A category with `count >= 3` and
`avg_composite < 0.5` is the blue team's next hypothesis target.
Categories with `count == 1` are too noisy to act on — wait for the red
team to add more before chasing them. If `pass_rate` is high but
`avg_composite` is low, the pipeline is *barely* passing — fragile to a
small regression.

**How the red team uses this.** It reads `per_category` to pick *which*
category to attack next: an *underrepresented* category (low `count`) is
a coverage gap. An *overrepresented but failing* category (high `count`,
low `avg_composite`) is a productive seam — easy adversarial wins.

---

## `pass_rate_at_0_6`

```text
pass_rate_at_0_6 : float in [0.0, 1.0]
```

Fraction of cases whose composite is **at or above 0.6**. The 0.6 cutoff
is `PASS_THRESHOLD` in `pipeline/metrics.py` and it is intentionally the
same number the red team uses as its "this case fails" line: a candidate
red-team case is only kept if `eval_single` returns a composite < 0.6.
Anchoring the two on the same number means the test set's notion of
"failure" matches the report's notion of "pass" exactly.

**Why 0.6, specifically.** With the default weights `0.4 / 0.3 / 0.3`,
a case that gets a *partial* (`0.5`) on correctness, a perfect (`1.0`)
recall@5, and a partial (`0.5`) on faithfulness lands at
`0.2 + 0.3 + 0.15 = 0.65` — i.e., "essentially right but with one soft
spot". 0.6 admits that. A case that gets a *full miss* (`0.0`) on
correctness can never clear 0.6 regardless of the other two — so we
never count a wrong answer as passing.

**Don't optimize this in isolation.** A blue-team change that nudges
`pass_rate_at_0_6` up by flipping a few near-miss cases from 0.55 to
0.65 isn't real progress — `composite_mean` will be roughly unchanged.
Real progress moves both numbers together.

---

## `regressions` / `recoveries`

```text
regressions : list[Regression]
  Regression:
    case_id  : str
    previous : float
    current  : float
recoveries  : list[str]   # case_ids only
```

Defined by **threshold crossings** between this iteration's report and
the previous one (`_diff_against_previous` in `metrics.py`):

- **Regression**: previous composite was `>= 0.6`, current is `< 0.6`.
- **Recovery**: previous was `< 0.6`, current is `>= 0.6`.

A case whose score wobbled from 0.65 → 0.62 is **not** a regression — it
stayed above the cutoff. Only the *threshold crossing* counts. This
avoids flagging tiny LLM-noise drifts as regressions, which would make
the signal useless.

**What the blue team does with `regressions`.** Treats any non-empty
`regressions` list as a hard signal to revert the most recent change.
The non-negotiable invariant in `CLAUDE.md` is: pipeline changes are
atomic, and a change that introduces *any* regression is reverted, even
if it improved `composite_mean` overall. Regressions also get appended
to `reports/regressions.md` for human review (`append_regressions_md`).

**What the red team does with `recoveries`.** Reads them as a hint that
the pipeline just got better in a specific way — that category is now a
less productive seam to attack. Pivot to a different category.

`regressions` and `recoveries` are empty on the first iteration of a
run (no `previous` report to diff against). This is normal, not a bug.

---

## `cost`

```text
cost : CostBlock
  oracle_calls   : int >= 0
  prejudge_calls : int >= 0
  cache_hits     : int >= 0
  usd_spent      : float >= 0.0
  tokens_in      : int >= 0
  tokens_out     : int >= 0
```

Per-iteration cost accounting. The accounting rule is the load-bearing
detail:

- **`oracle_calls`** — count of judge calls that went to Sonnet 4 (the
  oracle). Every consequential decision (accept/revert, regression
  scoring, final convergence judgment) is an oracle call. These cost
  USD.
- **`prejudge_calls`** — count of judge calls that went to the local
  vLLM-hosted prejudge (Qwen-14B by default). These cost nothing
  externally — they cost GPU time and electricity, which Bratan does
  *not* try to bill against `usd_spent`. Inner-loop sweeps and
  exploration use the prejudge; this number tends to be much larger
  than `oracle_calls` once the M3 inner-loop machinery is wired up.
- **`cache_hits`** — number of judge calls that were satisfied from the
  disk-backed response cache (M3's `pipeline/cache.py`). Free, fast,
  exact replay. Useful diagnostically: a sudden drop in `cache_hits`
  after a pipeline edit means the new code is producing different
  prompts than before.
- **`usd_spent`** — total USD billed against the Anthropic API for this
  iteration. **Only oracle calls contribute.** Prejudge calls and cache
  hits are zero-cost in this column.
- **`tokens_in` / `tokens_out`** — totals across *all* judge calls
  (oracle + prejudge), useful for sanity-checking the `usd_spent` math
  and for tracking when the judge starts producing unusually long
  rationales (a drift smell).

**Why the prejudge is "free" in this column.** It's the explicit M3
cost-control design: prejudge calls don't show up as USD even though
they cost compute, because the budget gating in `bratan.config.yaml →
usd_per_run` is specifically the API-spend ceiling. Local compute is
already paid for. If you want to track local-compute cost, use
`tokens_in`/`tokens_out` and multiply by your own electricity/GPU rate.

**Tripping the budget.** When cumulative `usd_spent` across iterations
exceeds the user-configured ceiling, the loop halts with
`stop_reason: budget`.

---

## `latency`

```text
latency : LatencyBlock
  p50_total_ms       : float >= 0.0
  p95_total_ms       : float >= 0.0
  p50_retrieval_ms   : float >= 0.0
  p95_retrieval_ms   : float >= 0.0
  p50_generation_ms  : float >= 0.0
  p95_generation_ms  : float >= 0.0
```

End-to-end timing percentiles. `total` is the judge's per-case wall time
(retrieval + generation + grading). `retrieval` and `generation` come
from the pipeline itself (lists of per-case milliseconds threaded into
`build_report`'s `retrieval_latencies_ms` / `generation_latencies_ms`
arguments).

**Percentile semantics.** Linear-interpolated percentile over the sorted
sample (see `_percentile`). p50 is the median; p95 is the 95th percentile.
With small N (the default seed set is ~50 cases), p95 is essentially
"the slowest few" — interpret accordingly.

**The empty-list corner case.** `_percentile([], p)` returns `0.0`. So
an iteration where no retrieval/generation timings were threaded
through (for instance, the very first eval-only run before the pipeline
instrumentation is wired up) will show `0.0` for those fields. That's
not a bug; that's "we have no data here". Don't read a 0 as "instant" —
read it as "missing".

**When p95 spikes.** A change that doubles p95 but leaves p50 alone is
usually a *new* slow path (e.g., a fallback to oracle on hard cases).
A change that lifts both is generally a global slowdown (model swap,
chunk-size increase, extra reranker hop).

---

## `pipeline_manifest_hash`

```text
pipeline_manifest_hash : str   # 16-char hex SHA-1 prefix
```

A short hash that uniquely identifies the **state of `pipeline/`** at the
moment the report was written. It covers:

- everything under `pipeline/**` (Python sources, prompts, adapters)
- `pipeline/config.yaml` (the blue-team-owned config)

It does **not** cover `bratan.config.yaml` (user-owned: judge weights
and budget ceilings are tracked separately in `judge_weights_hash` and
in the cost block).

**How it's computed.** When the working tree is a git repo, the hash is
SHA-1 over the output of `git ls-tree -r HEAD -- pipeline/` (fast and
respects `.gitignore`). When git isn't available, it falls back to
walking `pipeline/` and hashing every file's bytes. Either way, the
first 16 hex characters are used. See `pipeline_manifest_hash()` in
`pipeline/metrics.py`.

**Why it ties a report to exact code.** This is the only field that
makes historical scores *reproducible*. Two reports with the same hash
should produce the same scores (modulo LLM nondeterminism, which is
why the judge runs at temperature 0). If you see two consecutive
reports with the same hash but materially different `composite_mean`,
you have a judge-drift smell — bring it up in `low_confidence_verdicts`
and re-check.

---

## `test_set_size`

```text
test_set_size : int >= 0
```

Total count of test cases scored in this iteration (seed + all generated
files combined). Grows **monotonically** as the red team appends new
generated cases — the seed file is never modified, and red-team output
is append-only by invariant. A *decrease* between consecutive reports is
a bug or a manual file edit; raise it.

**Interpretation.** A growing `test_set_size` with a flat
`composite_mean` is healthy — the pipeline is keeping up with harder
tests. A growing `test_set_size` with a falling `composite_mean` means
the red team is winning faster than the blue team can catch up; that's
expected mid-run and unhealthy only if it persists.

---

## `drift`

```text
drift : DriftBlock
  samples_checked    : int >= 0
  disagreement_rate  : float in [0.0, 1.0]
```

Judge self-consistency telemetry. Periodically (configurable cadence),
the judge re-scores N random `(case, answer)` pairs drawn from
`reports/history/` and compares its new verdicts to the originals.

- **`samples_checked`** — how many history pairs were re-scored this
  iteration. Often `0` (drift checks don't run every iteration).
- **`disagreement_rate`** — fraction of those re-scores that disagreed
  with the stored verdict by more than a per-metric threshold.

**The halt rule.** When `disagreement_rate > 0.05` (>5%) for **three
consecutive** drift-check iterations, `stop_criteria.evaluate()` returns
`stop_reason: judge_drift` and the loop halts. The judge has told you it
no longer trusts itself; human review of the grading prompts is now
needed before any more iterations can be believed.

**Why drift detection is on the judge, not the pipeline.** The judge is
the load-bearing assumption of the whole loop. If the pipeline drifts,
the judge will catch it as a regression. If the judge drifts, *nothing*
catches it — except this check, by re-scoring the judge's own past
work.

---

## `judge_weights_hash`

```text
judge_weights_hash : str   # short hex
```

SHA over the judge composite weights `(w_correctness, w_recall,
w_faithfulness)` taken from `bratan.config.yaml → judge_weights`.
Computed by `pipeline.judge._hash_weights`.

**Why it's its own field.** If a human edits the weights mid-project,
every composite score in `reports/history/` becomes incomparable to
every new report — they're scoring on different units. Storing the hash
in every report lets you detect that incomparability automatically:
plot tools should refuse to draw a single trend line across two
different `judge_weights_hash` values, or at minimum mark the boundary.

**Invariants this enforces.** CLAUDE.md says the judge's grading prompt
does not change during a run. The same rule applies to the weights: a
mid-run weight change invalidates the run. Detect, surface, halt.

---

## `stop_reason`

```text
stop_reason : Literal[
  "convergence",
  "budget",
  "max_iterations",
  "anchor_regression",
  "judge_drift",
  "blue_stall",
  "manual",
] | None
```

`None` on every iteration except the final one of a run, where
`stop_criteria.evaluate()` writes the reason the loop halted. The seven
values mean:

- **`convergence`** — `composite_mean` improved by less than the
  configured `converge_threshold` for the configured number of
  consecutive iterations (5 by default). This is the *good* stop: the
  pipeline plateaued at a high score, more iterations would be wasted
  spend.
- **`budget`** — cumulative `cost.usd_spent` across iterations exceeded
  `bratan.config.yaml → usd_per_run`. The loop halts before the next
  iteration is started.
- **`max_iterations`** — the loop hit its configured iteration cap
  (`--iterations N` on `loop.py`). Not necessarily bad — it just means
  you bounded the run by wall time rather than convergence.
- **`anchor_regression`** — a *seed* test case (`created_by: human`)
  dropped below 0.6. Seed cases are the anchor; a regression on them is
  treated as an immediate halt so a human can review before more
  iterations build on the broken state.
- **`judge_drift`** — see `drift` above; three consecutive iterations
  with `disagreement_rate > 5%`.
- **`blue_stall`** — three consecutive iterations where the blue team
  reverted (no accepted change). Indicates the blue team is out of
  hypotheses for the current configuration; either the loop has
  converged in practice or it needs a new skill (M4 adds optimization
  skills exactly for this).
- **`manual`** — a human pressed stop in the dashboard or sent SIGTERM.

**How the blue team and judge behavior depend on this.** They don't,
directly — `stop_reason` is a *result*, not an input. But the **next**
run's blue team reads the last `stop_reason` from `reports/latest.json`:
`convergence` means "the easy wins are gone, reach for a harder skill";
`blue_stall` means "you tried twice already, get a different hypothesis";
`anchor_regression` means "stop and read `regressions.md` before doing
anything".

---

## `low_confidence_verdicts`

```text
low_confidence_verdicts : list[dict]
  each: {"case_id": str, "reason": str}
```

The judge's self-flagging channel. When the judge encounters a case it
can't grade with high confidence — ambiguous ground truth, missing
source passages, contradictory chunks, an answer that's partially
correct in ways the rubric doesn't cleanly handle — it logs the
case-id and a one-line reason here **instead of guessing**. The
composite score is still produced (it has to be, for the report to be
complete), but the entry in `low_confidence_verdicts` is a signal to
read that case's `by_case` row sceptically.

**Why this exists.** Two reasons. First, it's a pressure valve that
keeps the judge honest: the alternative to logging low confidence is
guessing, and a guessing judge contaminates the optimization signal.
Second, it accumulates a corpus of borderline cases that a human can
review between runs to refine the grading prompts (under the
`agents/judge/prompts/` rule that says only humans edit them).

**Things you'll typically see as `reason`.**

- `"ground_truth_ambiguous"` — multiple defensible answers exist
- `"source_passages_missing"` — case references corpus lines that no
  longer exist (corpus was rebuilt under it)
- `"retrieval_returned_nothing"` — pipeline returned 0 chunks; nothing
  to grade faithfulness against
- `"judge_drift"` — re-score disagreed with prior self by >5%

**What happens when this list grows large.** Nothing automatic — but
the dashboard surfaces it, and a count above ~10% of the test set is
a sign the grading prompts are no longer fit for purpose.

---

## Where to find what

- The data model: [`/pipeline/metrics.py`](../pipeline/metrics.py)
- The builder: `build_report()` in the same file
- Persistence: `write_report()`, `load_latest()`,
  `append_regressions_md()`
- Stop-reason decision logic: [`/pipeline/stop_criteria.py`](../pipeline/stop_criteria.py)
- The judge's verdict shape that feeds this report:
  [`/pipeline/judge.py`](../pipeline/judge.py)
- Test-case schema this report references: [`/test_cases/schema.md`](../test_cases/schema.md)
- Implementation status & what's still open:
  [`/docs/RESUME-HERE.md`](./RESUME-HERE.md)
