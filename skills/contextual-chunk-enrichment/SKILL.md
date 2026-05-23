---
name: contextual-chunk-enrichment
description: |
  Use this skill when chunks have ambiguous referents that hurt retrieval —
  for example, a paragraph starting "It supports up to 10,000 connections"
  where "it" is whatever the document is about. The technique prepends an
  LLM-generated context block to each chunk before embedding, so the chunk
  embeds in the right region of vector space.
---

# Contextual Chunk Enrichment

Popularized by Anthropic in 2024. The original chunk often lacks the
context needed to be retrievable on its own. The fix: use an LLM to
prepend a short context block to each chunk before embedding.

## When to use

Use this skill when failure analysis shows:
- Chunks that semantically should be retrievable but aren't
- High retrieval recall on questions that use the chunk's own
  terminology, but low recall on questions that reference the chunk's
  topic by name (where the chunk doesn't repeat that name)
- Documents with strong hierarchical structure where individual
  chunks lose their parent's identity

It's a heavy technique — every chunk needs an extra LLM call at
indexing time — so don't apply it preemptively.

## Procedure

For each chunk during indexing:

1. Take the chunk's text and a window of surrounding context (the
   parent document, or the parent section if the doc is huge).

2. Prompt a small fast LLM:
   ```
   Here is a document:
   <document>
   {whole_doc_or_section}
   </document>

   Here is a chunk from it:
   <chunk>
   {chunk_text}
   </chunk>

   Write a short context block (50-100 tokens) that situates the
   chunk in the document. Identify what it's about, what section it
   comes from, and any referents the chunk uses without defining.
   Do not summarize the chunk's content; you are situating it.
   ```

3. Concatenate the context block + the original chunk text. Embed the
   concatenation, store the original chunk text (without the context
   block) for the LLM to read at query time.

## Why it works

A chunk reading "It supports up to 10,000 concurrent connections"
embeds poorly because "it" is ambiguous; the vector lands somewhere
generic. Prepending "This chunk is from the load balancer
documentation, in the performance limits section. It describes
connection limits." gives the embedding model enough to land near
other load-balancer chunks, where load-balancer questions also land.

The trick is that the LLM at generation time sees only the original
chunk (not the enrichment), so the context window stays clean. The
enrichment only exists in the vector store.

## Cost considerations

- An LLM call per chunk at indexing time. With ~100,000 chunks, that's
  100,000 small LLM calls. Use prompt caching aggressively — the
  document body changes once per chunk, but the system prompt and the
  chunk-extraction logic don't.
- Indexing time goes from minutes to tens of minutes for a typical
  corpus. Acceptable for periodic re-indexing, expensive for live
  ingestion.
- Use a cheap model (Haiku-tier). The task is narrow.

## When NOT to use

- The corpus is already self-contained (each chunk has its own
  headings, parent references inline)
- You're early in tuning — try cheaper retrieval improvements (hybrid,
  reranker) before reaching for this
- Embedding model context limits are tight enough that adding
  enrichment crowds out the chunk's own content
