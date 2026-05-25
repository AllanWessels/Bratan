---
name: pre-handoff-clean-state-proof
description: Before saying "ready, retest", prove the state is clean by running a concrete numbered checklist. Never claim clean state — demonstrate it with real command output.
metadata:
  tags: [process, verification, handoff, discipline]
---

# Pre-Handoff Clean State Proof

## When to use

- You are about to tell the user "the fix is in, go retest."
- You just ran a verifier agent and are merging its report.
- You wiped state (disk, config, vector store) and restarted a server.
- Any situation where you are claiming the system is in a known-good state.

## When NOT to use

- The change was purely to a documentation file or SKILL.md with no runtime effect.
- You are handing off a work-in-progress explicitly labeled as such.

## How to apply

### The pattern

Build a numbered checklist specific to your project. Each item has three parts:

1. **The command to run** (real curl, ls, test -e — no "I believe" language).
2. **The expected output** (exact string or HTTP status code).
3. **The action if it fails** (fix it — do not hand off).

### Generic template

Adapt these to your stack. Every item must be verified by a real command:

```
Pre-handoff checklist — run every item, read every output:

1. Backend health:
   curl -sf http://127.0.0.1:<port>/api/health
   → Expected: HTTP 200, body {"ok":true}

2. App state reset:
   curl -sf http://127.0.0.1:<port>/api/setup/state
   → Expected: config_exists: false, setup_completed: false

3. Frontend reachable:
   curl -I http://127.0.0.1:5173/
   → Expected: HTTP 200

4. Ephemeral config gone:
   test -e <config_file> && echo STILL || echo gone
   → Expected: gone

5. Ephemeral DB gone:
   test -e <db_dir> && echo STILL || echo gone
   → Expected: gone

6. Data directories empty:
   ls <data_dir>/
   → Expected: empty or only README

7. Reports clean:
   ls reports/run-*.json 2>&1
   → Expected: "No such file or directory"

8. Frontend module currency (anti-stale-HMR check):
   curl -sS http://127.0.0.1:5173/src/<recently-changed>.tsx | head -5
   Compare against: head -5 <path-to-file>
   → Expected: byte-for-byte match

9. Store round-trip (catches stale in-memory clients):
   curl -sf -X POST http://127.0.0.1:<port>/api/corpus/search \
     -d '{"query":"x","k":1}' -H "Content-Type: application/json"
   → Expected: HTTP 200 (not 500), even against empty store
```

### The rule

If ANY check fails, fix it before handing off. "I think item 6 is probably
fine" is the failure mode this checklist exists to prevent.

Do not selectively run "the important ones." Run all of them. The one you
skip is the one that bites the user.

### Adapting the checklist

For a different stack, the structural items to cover are always:

| Category | What to check |
|---|---|
| Process health | Does the server respond? |
| State reset | Are config / setup artifacts gone? |
| Ephemeral data | Are test-generated files gone? |
| Module cache | Does the dev server serve current code? |
| Data layer | Does a round-trip query work against a clean store? |

### Adding project-specific items

When a new class of state-poisoning failure is discovered (see
[[verifier-state-vs-user-state]]), add it to the checklist immediately.
The checklist grows; it never shrinks.

## Why this works

The failure mode this skill prevents is confidence based on memory: "I ran
that fix, so the state must be clean." Memory is wrong. State-poisoning bugs
are characterized by being invisible until the user triggers them — the exact
moment the user takes back control. Running the checklist forces the system
to express its state in real output, which cannot be wrong in the way that
memory can.

## Anti-patterns to avoid

- **"I think the state is clean"** — the entire reason this skill exists.
  Think nothing; measure everything.
- **Running the checklist mentally without executing the commands** — counts
  as not running the checklist.
- **Partial checklist** — "I already checked 1–4 earlier" — re-run everything.
  State can change between "earlier" and now.
- **Reporting checklist results without the actual output** — the output is
  the proof, not the claim that it passed.

## Cross-links

- [[verifier-state-vs-user-state]] — why state can be dirty even after a disk wipe
- [[subprocess-isolation-for-process-state-clients]] — the structural fix that
  makes several checklist items more reliable
- [[parallel-fanout-verification]] — run the full harness before reaching this
  checklist; this checklist is the final gate
