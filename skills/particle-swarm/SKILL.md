---
name: particle-swarm
description: |
  Use this skill when the Blue Team needs to optimize over a mixed
  continuous + discrete + categorical space too large for grid search and
  too rough for Bayesian Optimization's Gaussian-Process surrogate.
  PSO and its evolutionary cousins (CMA-ES, GA) navigate jagged surfaces
  by maintaining a population of candidates that pull toward both
  individual and global bests.
---

# Particle Swarm Optimization

## When to use

- The search space mixes continuous (chunk_size, temperature), discrete
  (k, top_n), and categorical (embedding model, reranker model, prompt
  variant) parameters.
- The response surface is rough / multimodal — small parameter changes
  cause large score changes. BO's GP surrogate assumes smoothness and
  performs poorly here.
- You have enough budget to evaluate a population (typically 10–20
  particles) over 5–10 generations on the prejudge.

## When *not* to use

- Smooth, low-dimensional, continuous space → use BO.
- Small enumerable space → use grid sweep.
- Single most-important parameter → ablate it, then tune.
- You can't afford a few hundred prejudge evaluations. PSO trades sample
  efficiency for surface-robustness; that trade only pays off when the
  prejudge is cheap.

## The procedure

1. **Define the swarm.** 10–20 particles, each a full parameter vector
   sampled uniformly from the search space.
2. **Each generation:**
    - Evaluate every particle on `eval.py --subset --mode prejudge`.
    - Update each particle's velocity using its personal best and the
      global best, with the canonical PSO update:
      ```
      v ← w·v + c1·r1·(p_best − x) + c2·r2·(g_best − x)
      x ← x + v
      ```
      Defaults: inertia `w=0.7`, cognitive `c1=1.5`, social `c2=1.5`,
      `r1, r2 ~ U(0, 1)`.
    - Clamp categorical / discrete dimensions to the nearest valid
      value after the update.
3. **Terminate** when the global-best composite plateaus for 3
   generations, or when the budget is hit.
4. **Oracle-validate the global best** on the full test set. If it
   doesn't beat the incumbent, treat the entire PSO run as a
   low-confidence signal and *do not* persist.

## Variants worth knowing

- **CMA-ES** — Covariance Matrix Adaptation Evolution Strategy.
  Strictly better than vanilla PSO on continuous-only spaces, but
  doesn't natively handle categorical parameters. Use when your search
  space goes fully numeric.
- **NSGA-II** — multi-objective evolutionary algorithm. Use when the
  Blue Team wants the Pareto frontier of (composite, cost) or
  (composite, latency), not just the max-composite point.

## Why PSO earns its keep here

The pipeline's response surface is genuinely rough. Swapping the
embedding model from `bge-large` to `nomic-embed` doesn't just shift
the score by epsilon — it relocates the entire chunking + retrieval
sweet spot. PSO's population-based exploration catches those discrete
regime shifts in a way that single-point BO often misses.

## Composes with

- [`ablation`](../ablation/SKILL.md) — ablate first to factor the
  problem and reduce dimensionality.
- [`bayesian-optimization`](../bayesian-optimization/SKILL.md) — once
  PSO identifies the right *region*, BO inside that region refines the
  continuous axes.
