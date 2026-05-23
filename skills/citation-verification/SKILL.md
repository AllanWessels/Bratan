---
name: citation-verification
description: |
  Use this skill to add a post-generation pass that verifies every citation
  in the LLM's answer actually appears in (and is supported by) the cited
  chunk. Reach for it when the faithfulness score is low even though
  retrieval is healthy, or when invented citations are surfacing as a
  failure category.
---

# Citation Verification

## When to use

Add a verification pass when `/reports/latest.json` shows:
- High retrieval recall (>= 0.7 avg) but low faithfulness (< 0.6 avg)
- Failures in the "invented citation" category, surfaced by the judge

Don't add it if faithfulness is already high — it's an expensive pass
that you should only enable when the evidence demands it.

## How it works

After the LLM generates an answer with chunk-numbered citations, run
a separate verification pass:

1. Parse the answer into (claim, cited-chunk-id) pairs. Most
   citation formats like `... [3] ...` are easy to regex.

2. For each (claim, chunk) pair, call a fast LLM with a fixed prompt:
   ```
   Claim: {claim}
   Chunk: {chunk_text}

   Does the chunk directly support this claim? Reply with one word:
   YES, NO, or PARTIAL.
   ```

3. If all pairs return YES, the answer is verified. If any return NO,
   the answer has at least one fabricated citation. PARTIAL is a soft
   warning.

## What to do on failure

Three reasonable strategies depending on stakes:

- **Retry**: regenerate the answer with the same chunks but stronger
  grounding instructions. Usually fixes single-claim issues.
- **Downgrade**: replace the offending claim with "I'm not sure"
  or drop it from the answer. Keeps the rest of the answer usable.
- **Refuse**: return an honest "I don't have enough information"
  response. Highest-trust, lowest-coverage option.

For most consumer-facing systems, retry once then downgrade. For
high-stakes (medical, legal, financial) systems, refuse rather than
serve unverified content.

## Implementation requirements

Your generation prompt needs to use a citation format the verifier
can parse:

```
Use citations in the format [N] where N is the chunk number.
Place the citation immediately after the claim it supports.
Every factual claim must have a citation.
```

Then your verifier parses on `\[(\d+)\]` and matches each claim
(sentence containing the citation) to the chunk by number.

## Cost considerations

A verification pass adds one LLM call per cited claim. For a
typical answer with 3-5 citations, that's 3-5 small LLM calls
added to each query. The calls are cheap (small context, single
word output) but they're real latency. Budget for them.

Optimization: many claims share chunks. Group claims by chunk and
verify in batch — one call per (chunk, set-of-claims) pair instead
of per claim.

## When NOT to use

- Low-stakes use cases where occasional fabrication is acceptable
- Cases where the user can verify the answer themselves
- Early iteration — focus on retrieval and prompt-level grounding
  before adding a verification pass
