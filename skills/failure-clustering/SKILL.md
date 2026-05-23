---
name: failure-clustering
description: |
  Use this skill when you need to interpret /reports/latest.json to find the
  root cause behind multiple failing cases. Reach for it before making
  changes to the pipeline, so you fix one root cause at a time instead of
  whacking moles. The output is "here is the cluster, here is the
  hypothesis, here is the suggested fix layer".
---

# Failure Clustering

## When to use

Before any blue team change, read this skill to interpret
`/reports/latest.json` correctly. Most failing cases are not independent
problems; they cluster around a small number of root causes.

## The diagnostic matrix

The judge reports both `retrieval_recall@5` and `faithfulness` per case.
Plot the failing cases in your head:

|                         | Low retrieval        | High retrieval         |
|-------------------------|----------------------|------------------------|
| **High faithfulness**   | Honest "I don't know" — index gap or ingestion gap | Working ✓ (rare in failing cases) |
| **Low faithfulness**    | Both broken — fix retrieval first | Model ignoring context — prompt issue |

Pick which quadrant has the most cases. That tells you which *layer*
to fix.

## The four failure modes within those quadrants

1. **Answer missing from any chunk.** Diagnose by manually searching
   `/corpus/` for the answer. If you can't find it either, the
   knowledge base has a real gap; nothing pipeline-side will help.
   If you can find it but the index doesn't have it, that's an
   ingestion problem (parser, OCR, filter, freshness).

2. **Right chunk exists but wasn't retrieved.** Diagnose by running
   the failing question with a high `k` (50+) and checking whether the
   known-good chunk appears anywhere in the results. If absent: the
   embedding model is failing on this query type (try HyDE,
   multi-query, hybrid). If present but buried: add or upgrade the
   reranker, or increase initial k. If only one lane found it: check
   hybrid merge weights.

3. **Chunk retrieved but model ignored it.** Symptoms: the model
   cites a wrong chunk, or generates from prior knowledge despite
   having context. Fixes: tighten the prompt (`answer using ONLY the
   context`), reorder chunks so the most relevant is last, require
   chunk-numbered citations.

4. **Invented citation.** The model cites chunk [N] but chunk [N]
   doesn't actually contain the claim. Fix: add a post-generation
   citation verification pass (separate LLM call) that checks each
   citation. Expensive but unavoidable for high-stakes outputs.

## How to write a hypothesis

A good hypothesis for the blue team looks like:

> "8 failing cases cluster in `multi_hop` category. All 8 have low
> retrieval recall (avg 0.2). Manual inspection shows the question
> needs information from two corpus passages, but the retriever
> returns one and ignores the second. Hypothesis: a query
> decomposition step that splits multi-hop questions into independent
> sub-queries would lift recall on this cluster without affecting
> single-hop cases."

A bad hypothesis looks like:

> "Lots of cases are failing, let's try a bigger model."

The first is testable, scoped, and predicts a specific outcome. The
second is a guess that, even if it works, teaches you nothing.

## How to pick the cluster to attack

When multiple clusters exist, prefer (in order):

1. The largest cluster — fixing it moves the score most
2. The cluster you have the strongest hypothesis about — even if smaller,
   the iteration loop completes faster
3. Clusters at the retrieval layer before clusters at the generation
   layer — retrieval is upstream and the cheaper layer to fix

If two clusters tie, pick the retrieval one.
