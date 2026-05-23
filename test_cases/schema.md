# Test Case Schema

Test cases are JSON Lines files (one JSON object per line). Both the
seed file and red-team-generated files follow this schema.

## Required fields

```json
{
  "id": "string, unique slug, e.g. seed-001 or rt-2026-05-23-001",
  "question": "the test question, plain text",
  "ground_truth": "the correct answer, plain text",
  "source_passages": [
    {
      "path": "/corpus/path/to/doc.md",
      "line_start": 42,
      "line_end": 58
    }
  ],
  "failure_category": "one of the categories below",
  "created_by": "human | red-team",
  "created_at": "ISO-8601 timestamp"
}
```

## Optional fields

```json
{
  "hypothesis": "for red-team cases: why you think the pipeline fails on this",
  "notes": "free text for human readers"
}
```

## Failure categories

- `paraphrase_brittleness` — answer exists but uses different terms
- `multi_hop` — answer requires combining 2+ passages
- `structured_content` — answer is in a table, list, or code block
- `temporal_reasoning` — time-qualified ("recent", "before X")
- `negation_or_scope` — "what doesn't X do", scope qualifiers
- `disambiguation` — multiple similar entities in corpus
- `out_of_scope` — answer NOT in corpus; should refuse
- `straightforward` — for seed cases that aren't adversarial

## Validation

Before adding any case, verify:

1. The `source_passages` actually exist at those paths and line ranges.
2. The `ground_truth` is supported by content in those passages.
3. The `question` is unambiguous — has one defensible correct answer.
4. The `failure_category` matches what the case actually targets.

Cases that fail these checks get filtered by `scripts/eval.py` and
flagged in `low_confidence_verdicts` in the judge report.
