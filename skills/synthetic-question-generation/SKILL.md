---
name: synthetic-question-generation
description: |
  Use this skill when generating new failure-targeting test cases. Documents
  techniques for producing questions that are diverse, non-trivial, and
  actually defeat the current pipeline — not paraphrases of existing test
  cases. Most useful for the red team agent.
---

# Synthetic Question Generation

## When to use

The red team agent uses this skill to generate new test cases. The goal
is *adversarial coverage growth* — finding holes in the test set that
correspond to real holes in the pipeline.

## The trap to avoid

Naive LLM question generation produces variations on a theme. If your
existing test set has 10 questions about pricing, asking an LLM to
"generate more questions" gives you 10 more questions about pricing
phrased slightly differently. You want different *kinds* of questions,
not different *wordings* of the same kind.

## Generation strategies, ranked by adversarial yield

### 1. Multi-hop construction

Pick two random corpus passages. Find what's interesting about each.
Construct a question whose answer requires combining both.

Example: passage A describes the product's free tier limits, passage
B describes pricing in EU vs US. Question: "What's the EU price for
the smallest plan that exceeds free-tier limits?"

This often defeats single-pass retrieval — the system gets one
passage but not both.

### 2. Paraphrase distance maximization

Pick a corpus passage. Identify its key terms. Generate a question
whose answer is the passage but which uses *none* of those terms.

Example: passage says "the system supports horizontal autoscaling
with up to 100 worker pods". Question: "Can the cluster grow when
load spikes?"

Defeats pure vector retrieval when the embedding model leans on
surface tokens.

### 3. Disambiguation pressure

Find two corpus entities with similar names (Product A v1, Product A
v2). Generate a question that's specific to one but could be confused
for the other.

Defeats retrieval when the embedding model collapses similar entities
into the same vector region.

### 4. Negation and scope

"What is NOT supported in the free tier?" "What features are excluded
from the basic plan?" Questions with negation or scope qualifiers
often defeat naive retrieval because the retriever finds passages
about what *is* included.

### 5. Temporal phrases

"What changed in the last release?" "What was the policy before
2024?" Requires both retrieval-time filtering and reasoning over
temporal qualifiers in the corpus.

### 6. Out-of-scope refusal probes

Generate questions whose answers do NOT exist in `/corpus/`. The
pipeline should refuse, not hallucinate. This is a different failure
mode (hallucination) that tests refusal behavior.

## Procedure for the red team

1. Look at `/reports/latest.json` → `by_failure_category`. Find the
   category with the FEWEST current test cases. Target that.

2. Read 5-10 random corpus passages. Note which entities, time
   periods, and topics they cover.

3. Use the strategy that matches the under-tested category. If
   `multi_hop` is underrepresented, use strategy 1. If
   `paraphrase_brittleness` is underrepresented, use strategy 2.

4. Generate 10 candidates. For each, verify the answer is in the
   corpus by citing the exact passage. If you can't cite, throw it
   out.

5. Run each candidate through `scripts/eval_single.py`. Keep only
   the ones that fail (composite < 0.6).

6. Append the kept cases to `/test_cases/generated/<timestamp>.jsonl`.

## Quality bar

Each test case must be:

- **Answerable** — the ground truth is in `/corpus/`, you can point
  to the passage
- **Fair** — a reasonable system *could* answer it given the corpus.
  Trick questions that no system could handle are useless
- **Specific** — has a single correct answer, not five plausible ones
- **Diverse** — meaningfully different from existing cases in
  category, phrasing, and corpus coverage

If you're producing 10 cases that all hit the same passage of the
same document, you're paraphrasing, not testing.
