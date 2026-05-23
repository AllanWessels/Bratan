# Corpus

Drop your source documents here. The pipeline ingests everything in this
directory recursively.

Supported formats out of the box:
- `.md` / `.txt` — plain text and markdown
- `.html` — parsed with BeautifulSoup
- `.pdf` — extracted with pypdf (use pdf-reading skill for scanned PDFs)

Other formats: add a loader in `pipeline/ingest.py`. The chunking
strategy is configurable in `pipeline/config.yaml`.

## Important

**This directory is read-only for the agents.** The red team verifies
ground truth against it. The judge scores against it. If `/corpus/`
shifts mid-loop, all historical scores become incomparable.

If you need to update the corpus, do it as a deliberate human action,
re-baseline by running `scripts/loop.py --iterations 0` (judge only),
and document the change here.

## Versioning

Track corpus changes in this file:

| Date | Change | Re-baseline score |
|---|---|---|
| YYYY-MM-DD | initial corpus | TBD |
