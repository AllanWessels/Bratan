---
name: grid-sweep
description: |
  Use this skill when the Blue Team is tuning 1–2 discrete or low-cardinality
  parameters (k, top_n, rrf_k, chunk_overlap) and the Cartesian product is
  small enough to enumerate exhaustively. Simpler than Bayesian Optimization,
  with the advantage that every cell of the grid is reported so the result
  is visually inspectable.
---

# Grid Sweep

## When to use

- Parameter cardinality is small: 4–6 values per axis, 1–2 axes max.
- The Blue Team wants to *see* the response surface, not just the
  optimum. A surface that's flat in `k` but sharply peaked in `top_n`
  is information that BO would hide.
- Sanity-checking a Bayesian result — does the BO winner match what a
  grid says?

## When *not* to use

- More than 2 axes, or any axis with >8 values. Cost grows as the
  product. Reach for `bayesian-optimization` or `particle-swarm`.
- Continuous parameters. Use BO.
- The parameters interact strongly with structural choices (chunker
  strategy, reranker on/off). Run `ablation` first to factor the
  problem.

## The procedure

1. **Define the grid** as comma-separated values per parameter.

   ```bash
   uv run python scripts/sweep.py \
       --param retrieval.vector.k --grid 5,10,20,40 \
       --param retrieval.reranker.top_n --grid 3,5,10 \
       --judge prejudge --subset 10
   ```

2. **Inner-loop with prejudge on a subset.** 12 cells × N cases on the
   prejudge is fast and free. The point is to find the winner cell, not
   to publish numbers.

3. **Emit a CSV** of `(param values) → composite, recall@5, faithfulness`
   so the Blue Team can scan the surface. The runner picks the cell
   with the highest composite on the subset.

4. **Oracle-validate the winner.** A single full oracle eval on the
   winning cell. If it doesn't beat the incumbent on the full set,
   *don't* persist — the prejudge ranking was misleading and we treat
   it as a low-confidence signal for the next iteration.

## Heuristics for good grids

- **Logarithmic spacing** when the range spans an order of magnitude.
  `k ∈ {5, 10, 20, 40}` is better than `{5, 15, 25, 35}` because the
  expected response is usually log-shaped.
- **One axis at a time** when in doubt. A 1-D sweep tells you the right
  range; the 2-D sweep refines.
- **Center the grid on the current value.** A sweep that doesn't include
  the incumbent is a sweep that can't tell you whether you regressed.

## Composes with

- [`bayesian-optimization`](../bayesian-optimization/SKILL.md) — grid
  first to bound the region, then BO inside.
- [`ablation`](../ablation/SKILL.md) — ablation tells you *which*
  parameters matter; grid tells you *what value* each should take.
