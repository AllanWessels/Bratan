---
name: rag-architect
description: |
  Use this skill when you need high-level guidance on the structure of a
  RAG pipeline — what stages it should have, what trade-offs each stage
  makes, when to add or remove a stage. Reach for it for architectural
  decisions, not numeric tuning.
---

# RAG Architect

This skill is the design-level reference. Read it when you're deciding
*what stages a RAG pipeline should have*, not when you're tuning numbers
within a stage.

## The two pipelines

RAG is two pipelines that share a vector store:

- **Indexing** (offline, runs when docs change): load -> parse -> chunk
  -> embed -> upsert
- **Query** (online, runs per question): embed -> retrieve -> rerank ->
  build prompt -> generate -> answer

The key insight binding them: both must use the **same embedding model**.

## Stages in a mature query pipeline

```
question
  -> [optional] should-we-retrieve classifier  (adaptive)
  -> [optional] query rewrite (resolve "it", "the other")
  -> [optional] query expansion / HyDE / multi-query
  -> embed query
  -> [parallel] BM25 retrieval  +  vector retrieval
  -> RRF merge
  -> [optional] metadata filter
  -> reranker (cross-encoder)
  -> top-N chunks
  -> build prompt with explicit grounding instructions
  -> LLM generates answer with citations
  -> [optional] citation verification pass
  -> answer
```

Not every pipeline needs every stage. The discipline is: only add a stage
if `/reports/latest.json` shows a failure category that stage addresses.

## Stage purposes — when to add each

| Stage | Add when |
|---|---|
| Adaptive retrieval classifier | Latency is a problem, or many user messages don't need retrieval (greetings, follow-ups) |
| Query rewriting | Failures cluster on conversational follow-ups (`what about the other one`) |
| HyDE | Failures cluster on questions whose phrasing is very different from documents |
| Multi-query | Single-phrasing brittleness; one paraphrase works, another doesn't |
| Hybrid (BM25 + vector) | Failures involve exact tokens — product names, error codes, version numbers |
| Reranker | The right chunk appears in top-30 but not top-5 |
| Citation verification | Faithfulness scores low even when retrieval is good |
| Small-to-big retrieval | Chunks retrieve well but answers are incomplete because surrounding context is missing |
| Metadata filtering | Questions have temporal or scope qualifiers ("last quarter", "engineering team") |
| Contextual chunk enrichment | Chunks have ambiguous referents ("it supports up to N") |

## Anti-patterns

- Adding a stage because it's fashionable, without evidence in the report
- Optimizing generation when retrieval recall is below 0.7
- Adding more chunks to the prompt when the model already ignores some
- Lowering the score threshold to "fix" a regression instead of fixing it

## When to step back from this skill

If the problem is *numeric* (chunk size, k, overlap, rerank model
choice), this skill won't help. Use evidence from the report to pick a
specific stage's parameter to tune, change it, measure.

If the problem is *architectural* (no stage exists for this failure
mode), this skill is exactly the right reference. Pick the missing stage
from the table above and add it.
