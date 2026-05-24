# Why the architecture looks like this

This document captures the design reasoning so future maintainers don't
have to re-derive it. Read it once before changing structure; you don't
need it for day-to-day work.

## The starting premise

The only way a RAG keeps improving is a **closed feedback loop** between
adversarial test generation, hypothesis-driven engineering, and a stable
judge. Without that loop, every system converges to a local optimum on
whatever eval set its authors wrote down on day one and then stops
moving. The techniques you've heard of — hybrid retrieval, query
rewriting, contextual chunk enrichment, reranking, citation
verification, adaptive retrieval, metadata filtering, and a dozen
smaller refinements — are individually well-understood. What's missing
in most production systems isn't a technique. It's the loop that would
tell you *which* technique to reach for next and *whether* the last one
you tried actually helped.

So the central design question becomes: **how do you close the loop —
red → blue → judge → red — so it keeps producing real improvement
instead of overfitting to a static eval?** A *consequence* of running
the loop is that techniques accumulate over time (every SKILL.md is a
technique the blue team picked up because the loop's reports told it
to). But the techniques are the output. The loop is the premise.

## Approaches considered

### Approach 1: wire together specialist tools
Use GEPA for prompt optimization, RAGAS for synthetic test generation,
LangSmith for traces, plus glue code. This is how most 2024-era
production systems work.

**Why we didn't pick this:** four packages with four release cycles,
four API surfaces, four version-compatibility risk vectors. The glue
code is where bugs live and where institutional knowledge dies. Also,
each tool's search space is fixed by its designers — you can't tune
what they didn't expose.

### Approach 2: three agents with markdown specs
Replace the tool wiring with three coding agents — red team, blue
team, judge — each defined by an `AGENTS.md`. They share a workspace
and a git repo. An orchestrator runs them in a loop.

**Better, because:** the agents reason at the level we care about
(failure categories, hypotheses, structural changes), not at the level
the tools were designed to expose (specific search spaces).

**Still missing:** where do the techniques live? Embedding them in the
agent prompts means every prompt grows over time. The blue team
prompt becomes a wall of "if X then try Y" rules.

### Approach 3: agents plus skills
What we picked. Agents are thin — they describe role, workflow,
constraints. Techniques live as `SKILL.md` files in `/skills/`. An
agent reads only the skills it needs for a specific task. New
techniques become new SKILL.md files; the agents don't grow.

This is the same pattern Anthropic uses for its own
`anthropics/skills` repo. We chose it because (a) it's the canonical
agent-system pattern as of 2026, (b) it makes the system inspectable
— every technique is readable markdown, not opaque optimizer state,
(c) it composes: agents and skills don't need to know about each
other's internals, and (d) skills can be authored by the blue team
itself when it discovers a new technique works.

## The red-team / blue-team / judge split

The naive version of self-improving RAG is one agent that proposes
changes and measures them. That's an actor-critic setup, and it works,
but it has a known failure mode: it overfits to the fixed eval set.
The system gets better at the test cases without getting better at the
problem.

The three-agent split is genuinely adversarial. The red team's job is
to make the test set harder *because* the pipeline got better. This
prevents convergence to a local optimum on a static eval. As the
pipeline learns to handle multi-hop questions, the red team starts
generating multi-hop questions with deceptive surface features. The
test set keeps moving because the pipeline keeps moving.

The judge is a separate role because the optimization signal needs to
come from a source that isn't also the optimizer. If the blue team
graded its own work, it would learn to grade leniently. If the red
team graded the blue team, it would over-fail to justify its existence.
The judge is the only stable ground truth in the loop.

## What we explicitly left out

- **Fine-tuning.** All improvements happen at prompt, configuration,
  and pipeline-code level. If you hit the ceiling of this approach,
  fine-tune separately. We don't want the loop's iteration time
  bottlenecked on training runs.
- **A web service / production deployment.** This is an optimization
  workspace, not a production system. Once the pipeline is good, you
  deploy `query.py` however you want. The repo doesn't dictate that.
- **Multi-tenancy / permissions.** A real production RAG needs per-user
  permission filtering at retrieval time. We don't model that here
  because the optimization loop is single-tenant. Add it when you
  deploy.

## The known fragility

The judge is the load-bearing assumption. If the judge is unreliable,
the loop optimizes toward noise. We mitigate this in three ways:

1. Temperature 0 + fixed grading prompts (determinism)
2. Periodic consistency checks against the judge's prior verdicts
   (drift detection)
3. Human-anchored ground truth — every test case has a human-verified
   source passage, so the judge has something to compare against
   rather than inventing standards

If LLM-as-judge ever drifts substantively, the whole project's
correctness collapses. This is the failure mode worth watching for.

## When to break the rules in this repo

If you find yourself wanting to:

- Edit `/test_cases/` to make scores better → stop, this defeats the
  point. Fix the pipeline, not the test set.
- Add a stage because it's fashionable → stop, only add stages that
  the report identifies a need for.
- Refactor `/pipeline/` because the code is messy → mild refactors
  are fine if they don't change behavior, but blue team's job is
  metric-driven, not aesthetic.
- Combine the agents into one because the loop is slow → resist;
  the separation is what gives you adversarial dynamics. Slow is fine;
  you can run the loop overnight.

## What references shaped this

- Anthropic's contextual retrieval paper (the chunk-enrichment idea)
- GEPA (the genetic-Pareto prompt optimization paper; the search-with-
  reflection idea)
- DSPy / MIPROv2 (the "compile a pipeline" framing)
- Anthropic's `skills/` repo (the SKILL.md format itself)
- Microsoft's BlueCodeAgent (the red-team/blue-team architecture
  applied to a different but structurally identical problem)
- RAGAS (synthetic test generation via evolutionary mutation)

None of those are dependencies; they're the conceptual ancestors.
