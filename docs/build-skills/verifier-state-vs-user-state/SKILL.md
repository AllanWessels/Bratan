---
name: verifier-state-vs-user-state
description: When verifier agents share a long-running server process with the user, state that poisons the verifier flows directly into the user's next interaction. End every verifier run with process-level restart and a round-trip health check.
metadata:
  tags: [process, testing, state, infrastructure]
---

# Verifier State vs. User State

## When to use

- A verifier agent (Playwright, pytest integration, live curl checks) runs against
  the same uvicorn / dev-server process the user interacts with.
- You are about to hand control back to the user after a verification run.
- The stack includes any component that holds per-path singleton state in process
  memory (chromadb, sqlite-WAL in certain modes, in-process caches).
- You just did a disk wipe and called it "state reset."

## When NOT to use

- The verifier runs against a hermetic test database / in-memory store that is
  torn down after each run and never shared with user-facing processes.
- The verification target is a stateless HTTP service (pure function, no
  file-system or in-memory persistence).

## How to apply

### The problem in one sentence

`Playwright reuseExistingServer: true` and `pytest` integration tests that hit
a live backend all share the user's dev process. Any in-memory state the
verifier creates or corrupts is still there when the user's next request arrives.

### End-of-verifier-run protocol (run in this order, skip nothing)

```bash
# Step 1: Use any reset endpoint the app exposes
curl -sf -X POST http://localhost:<port>/api/system/reset-vector-store

# Step 2: Kill the server process so all in-memory singletons die
pkill -9 -f "uvicorn.*<your_app_module>"
# or for Node: pkill -f "node.*vite"

# Step 3: Wipe on-disk state that the new process will read
rm -rf .chroma bratan.config.yaml .bratan-setup.json
# (adapt paths to your project's ephemeral state files)

# Step 4: Restart fresh
uvicorn <your_app_module>:app --host 127.0.0.1 --port <port> &

# Step 5: Round-trip health check — must succeed before handoff
curl -sf http://localhost:<port>/api/health
curl -sf -X POST http://localhost:<port>/api/corpus/search \
  -d '{"query":"x","k":1}' -H "Content-Type: application/json"
# Both must return 2xx (not 500) — even against an empty store
```

If step 5 returns 500, GOTO step 2. The reset endpoint alone is not sufficient
if the in-memory client survived.

### Why "disk wipe" is not enough

Some clients (chromadb being the canonical case) initialize their storage
connection at startup and cache it as a module-level singleton. Wiping the
files on disk does not notify the in-memory client. The client then reads from
a path that no longer matches what it expects, producing errors like:

- `OperationalError: no such table: tenants`
- `OperationalError: no such table: databases`
- `Nothing found on disk` (path mismatch)
- `dim mismatch` (collection created against a different embedding model)

All four are the same root cause: a stale client object surviving a disk wipe.
The only reliable fix is process-level restart.

### The Vite HMR variant

The same principle applies to Vite's HMR cache. If a component was edited
on disk but Vite's module cache still holds the old version:

```bash
# Verify currency: served bytes must match disk
curl -sS http://127.0.0.1:5173/src/<recently-changed-component>.tsx | head -5
# compare against: head -5 <path-to-component>

# If stale, restart:
pkill -f "node.*vite"
npm run dev -- --port 5173 --host 127.0.0.1 &
```

## Why this works

The verifier and the user share a process, which means they share a memory
heap. There is no isolation boundary between a "test run" and a "real session"
at the process level. The only way to guarantee isolation is to make them run
in separate process lifetimes. A process restart is the only operation that
reliably clears in-memory singleton state.

## Anti-patterns to avoid

- **"I wiped the disk, so the state is clean"** — disk wipe does not clear
  in-memory clients. Always follow with a process restart.
- **"The reset endpoint returned 200, so we're fine"** — the reset endpoint
  may only clear some state. Always verify with a round-trip query after restart.
- **Handing control back to the user before completing the protocol** — the
  user's first action after handoff will hit the poisoned process.
- **"Passing tests mean the state is clean"** — tests may pass against stale
  state if the stale state happens to satisfy the test's expectations.

## Cross-links

- [[subprocess-isolation-for-process-state-clients]] — the structural fix that
  makes this protocol unnecessary for the specific class of singleton clients
- [[pre-handoff-clean-state-proof]] — the checklist that operationalizes this
  protocol as a mandatory pre-handoff gate
- [[parallel-fanout-verification]] — how to structure verifier agents so they
  don't interfere with each other
