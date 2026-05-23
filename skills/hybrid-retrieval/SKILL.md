---
name: hybrid-retrieval
description: |
  Use this skill when failures show that vector search is missing exact-token
  matches (product names, error codes, version numbers, identifiers) or
  conversely when keyword search is missing semantic paraphrases. This skill
  documents how to add a BM25 lane alongside the vector lane and merge the
  results with Reciprocal Rank Fusion.
---

# Hybrid Retrieval

## When to use

Add hybrid retrieval when `/reports/latest.json` shows either:
- **Paraphrase-brittleness failures** with high BM25 baseline scores —
  vector search is missing things keyword search would catch
- **Exact-token failures** where queries reference specific identifiers
  (product names, error codes, version strings) and vector recall is low

If the report shows that retrieval is working but generation is the
problem, this skill is the wrong place to look.

## Why hybrid beats either alone

Pure vector search and pure keyword search fail in opposite ways:

- **Vector** struggles when exact tokens matter — error codes,
  identifiers, product names all embed to roughly the same region
- **Keyword** struggles with paraphrase — "cancel my subscription" finds
  nothing if the doc says "terminate your plan"

A hybrid system runs both in parallel and merges. The merge does not
need calibrated scores from either side, only ranks.

## Reciprocal Rank Fusion (RRF)

For each candidate document, sum across all retrieval methods:

```
score(doc) = sum over methods of:  1 / (k + rank_in_method)
```

`k=60` is the conventional constant. A doc ranked 1st in both lists
scores `1/61 + 1/61 ≈ 0.033`. A doc ranked 1st in only one list scores
`1/61 ≈ 0.016`. Documents that appear in both lists, even at moderate
ranks, beat documents that appear in only one.

## Implementation procedure

1. **Add a BM25 index alongside the vector index.** Use `rank_bm25`
   (pure Python, ~50 lines of integration). Index the same chunks that
   are in the vector store, so document IDs align.

2. **Wire both into `/pipeline/query.py`.** At query time:
   - Run BM25, get top-N1 ranked list (default N1=50)
   - Run vector search, get top-N2 ranked list (default N2=50)
   - Apply RRF over the union, sorted by RRF score
   - Take top-K of the merged list (default K=20) before reranking

3. **Tune the lane sizes.** N1 and N2 can be tuned but defaults are
   usually fine. The reranker downstream is what really decides what
   the LLM sees; the lanes' job is just to cast a wide net.

4. **Validate per failure category, not just overall.** Hybrid
   helps exact-token failures a lot, paraphrase failures a little. If
   overall score moves but a specific category gets worse, investigate.

## Gotchas

- **Stop words** — BM25 weighting can be skewed by short queries
  containing only common words. Either run a stopword filter or accept
  that vector dominates on short queries
- **Tokenization mismatch** — if BM25 tokenizes "v2.0" differently from
  the embedding model, recall on version strings can underperform.
  Either share a tokenizer or pre-process queries
- **Performance** — running both lanes is roughly 2x the latency unless
  you parallelize. In Python, `asyncio` or `concurrent.futures` makes
  this trivial; do it from day one

## Validation hypothesis to log

When you commit a hybrid retrieval change, the changelog entry should
specify:
- which failure category you expected to fix
- expected magnitude of improvement
- expected null result for unrelated categories

If your measured result diverges substantially from the hypothesis,
that's a signal something else is going on.
