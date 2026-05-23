# Pipeline Changelog

The blue team appends an entry here every time it keeps a change.
Entries are read by future blue-team invocations as institutional memory.

Format:

```
## YYYY-MM-DD <short-hash>
**Change:** one sentence describing what changed
**Hypothesis:** one sentence describing why you expected it to help
**Result:** overall score N.NN -> M.MM; fixed K cases in category X
**Notes:** optional gotchas or observations
```

---

## Initial baseline
**Change:** initial pipeline created (naive RAG: chunk -> embed -> top-5 -> generate)
**Hypothesis:** establish baseline; no optimization yet
**Result:** TBD on first judge run
**Notes:** retrieval is vector-only, no rerank, no rewriting. Almost everything
          here is a candidate for improvement.
