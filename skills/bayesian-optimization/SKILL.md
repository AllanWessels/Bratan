---
name: bayesian-optimization
description: |
  Use this skill when the Blue Team needs to tune a small set of numeric
  hyperparameters (chunk size, top-k, rrf_k, top-n for reranker, generation
  temperature) and the eval call is expensive enough that random or grid
  search would burn the budget. Bayesian Optimization uses a probabilistic
  surrogate (Gaussian Process or Tree-structured Parzen Estimator) to
  propose the next point most worth evaluating.
---

# Bayesian Optimization

## When to use

- The Blue Team has identified a numeric tuning opportunity from the
  failure cluster — *not* a structural change. (Structural changes go
  through `rag-architect` instead.)
- The search space is 1–5 continuous or low-cardinality discrete
  parameters. BO struggles past ~10 dimensions.
- A full eval costs more than a few cents, and the prejudge can be used
  for the inner-loop evaluations.

## When *not* to use

- The eval is cheap enough that `grid-sweep` is just as fast and is
  easier to reason about.
- The parameter space is high-dimensional (>10). Reach for ablation or
  factor the problem instead.
- You haven't formed a hypothesis about *why* this parameter matters.
  BO without a hypothesis is just a slower random search.

## The procedure

1. **Define the search space** in `scripts/sweep.py --param` form. Use
   log scale for any parameter that spans an order of magnitude (e.g.,
   `temperature ∈ [0.0, 1.0]` is linear; `learning_rate ∈ [1e-5, 1e-1]`
   is log).
2. **Pick an acquisition function.** Expected Improvement (EI) is the
   safe default. Use Upper Confidence Bound (UCB) when you want to
   explore further from the current best.
3. **Budget: ~10 trials per parameter dimension** as a starting heuristic.
   Stop early if the acquisition function's expected improvement drops
   below noise.
4. **Inner-loop with the prejudge.** Each candidate point is evaluated
   on a subset of the test set using `eval.py --subset --mode prejudge`.
5. **Oracle-validate the winner.** Before persisting the new parameter
   value to `pipeline/config.yaml`, run a full oracle eval on the
   candidate and confirm it beats the incumbent.

## Implementation note

Use [`scikit-optimize`](https://scikit-optimize.github.io) or
[`Optuna`](https://optuna.org) — both ship as small pure-Python deps
that fit `scripts/sweep.py` without dragging in a heavy framework.
Optuna's TPE is the default we recommend for this project because it
handles conditional and categorical parameters naturally, which matters
once the Blue Team starts tuning prompt-template variants alongside
numerics.

## Why this beats random search here

Random search is 10× wasteful when the eval is the bottleneck (which it
is for us — every trial is N pipeline runs + N judge calls). BO doesn't
care about absolute search efficiency; it cares about *sample
efficiency*. With a Sonnet 4 oracle costing real money per pass, that's
the metric that matters.

## Composes with

- [`grid-sweep`](../grid-sweep/SKILL.md) — start with a coarse grid to
  bound the region, then refine with BO inside the best subregion.
- [`ablation`](../ablation/SKILL.md) — ablate first to identify which
  parameters even matter; then BO only the ones that do.
- [`failure-clustering`](../failure-clustering/SKILL.md) — pick a
  parameter that the cluster suggests will help (e.g., chunk_size for a
  "structured_content" cluster), don't tune blindly.
