---
name: ablation
description: |
  Use this skill to attribute the contribution of each pipeline stage by
  systematically disabling one stage at a time and re-running eval. Tells
  the Blue Team whether reranking (or hybrid retrieval, or query rewriting,
  etc.) is actually paying its keep, and which stage to invest tuning
  effort in. Reach for it before any non-trivial structural change.
---

# Ablation Study

## When to use

- The Blue Team is considering removing, replacing, or heavily tuning a
  stage and needs to know how much that stage actually contributes.
- A previous change regressed and was reverted — ablation can tell you
  whether the change interacted badly with another stage you don't think
  about.
- You're about to spend budget tuning a stage that might be doing
  nothing. Always ablate first.

## When *not* to use

- The pipeline is still in its infancy (1–2 stages). Ablation is
  diagnostic for *mature* pipelines.
- You already have a confident hypothesis from `failure-clustering`
  pointing at the right stage. Skip straight to the fix.

## The procedure

1. **Enumerate the stages** currently in the pipeline. Read
   `pipeline/config.yaml` and `pipeline/query.py`. Typical stages worth
   ablating:
   - query rewriting
   - hybrid retrieval (turn off BM25 lane → vector-only)
   - reranker
   - contextual chunk enrichment (at ingest time)
   - citation verification post-pass
2. **For each stage, set `enabled: false` in `config.yaml` in a
   throwaway branch and run a full eval.** Record the composite delta
   from the incumbent.

   ```
   Stage                          Composite delta vs full
   full pipeline                  0.000  (baseline)
   - query rewriting              -0.012  (low impact, candidate to remove)
   - BM25 hybrid lane             -0.041  (real contribution)
   - reranker                     -0.087  (load-bearing — do not remove)
   - contextual chunk enrichment  -0.003  (within noise; candidate to remove)
   - citation verification        -0.018  (matters for faithfulness)
   ```

3. **Use prejudge for the ablation pass.** This is a comparative study,
   not a publication; the prejudge has plenty of signal for relative
   ranking. Oracle-validate only the *decisions* (remove a stage,
   re-tune a stage).

4. **Persist the result** in `pipeline/CHANGELOG.md` so the next Blue
   Team iteration knows what was already tested.

## Reading the result

- **Delta within ±0.005 of baseline** → that stage is contributing
  nothing on the current test set. Candidate for removal unless you
  have a principled reason to keep it (e.g., it's there for a failure
  mode the red team hasn't generated yet).
- **Large negative delta** → load-bearing stage. Tune carefully, never
  remove without a replacement.
- **Positive delta when removed** → the stage is *hurting*. Either it's
  miscalibrated or it's the wrong stage for this corpus. Remove and
  iterate.

## Why ablation is the first move for a mature pipeline

Pipelines accumulate stages because every paper said adding the stage
helps. After enough iterations, you've inherited stages that no longer
help on *your* corpus, and they're costing you latency, money, and
sometimes accuracy. Ablation is the only honest way to find them.

## Composes with

- [`bayesian-optimization`](../bayesian-optimization/SKILL.md) — ablate
  first, then BO only the stages that contributed.
- [`failure-clustering`](../failure-clustering/SKILL.md) — if the
  clustering is unclear, ablation gives you the orthogonal view.
