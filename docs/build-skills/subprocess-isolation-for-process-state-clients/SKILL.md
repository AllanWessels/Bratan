---
name: subprocess-isolation-for-process-state-clients
description: Wrap both read and write paths through any client that holds per-path singleton state in a subprocess worker, so on-disk state changes are always reflected without a full process restart.
metadata:
  tags: [architecture, state, isolation, reliability]
---

# Subprocess Isolation for Process-State Clients

## When to use

- A library initializes its storage connection once at import time and caches
  it as a module-level or class-level singleton (chromadb, certain sqlite-WAL
  setups, FAISS index objects).
- The on-disk state can change at runtime (wipe, schema migration, embedding
  dimension change, collection rename) without restarting the parent process.
- Tests or verifier runs need to exercise a clean state while the parent
  process is still running.
- You have seen errors like "no such table: tenants", "dim mismatch", or
  "Nothing found on disk" after a disk wipe.

## When NOT to use

- The client already provides a reliable `reset()` / `close()` / reconnect API
  that genuinely clears all in-process state. (Verify this claim — many
  "reset" APIs only clear the logical state, not the connection pool.)
- The client is stateless (pure-function, no file handles, no connection
  objects).
- The operation is hot-path latency-sensitive and a fork/exec overhead is
  unacceptable. In that case, use [[verifier-state-vs-user-state]] to manage
  the process boundary manually instead.

## How to apply

### The structural pattern

Create a worker module that owns the client entirely:

```python
# scripts/query_worker.py  (the worker — nothing else imports the client)
import sys, json, os

def main():
    payload = json.loads(sys.stdin.read())
    # Import the singleton client HERE, inside the subprocess, not at module top
    import chromadb  # or whatever the singleton client is
    client = chromadb.PersistentClient(path=payload["db_path"])
    collection = client.get_or_create_collection(payload["collection"])
    results = collection.query(
        query_embeddings=[payload["embedding"]],
        n_results=payload["k"],
    )
    json.dump(results, sys.stdout)

if __name__ == "__main__":
    main()
```

In the parent service, wrap both read AND write paths:

```python
import subprocess, json, sys

def _call_worker(payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, "scripts/query_worker.py"],
        input=json.dumps(payload).encode(),
        capture_output=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
    return json.loads(proc.stdout)

def query(embedding, k, db_path, collection):
    return _call_worker({"embedding": embedding, "k": k,
                         "db_path": db_path, "collection": collection})

def ingest(chunks, db_path, collection):
    return _call_worker({"chunks": chunks, "db_path": db_path,
                         "collection": collection, "op": "ingest"})
```

### The asymmetry trap

The most common mistake is wrapping only the WRITE path (ingest) in a
subprocess while leaving the READ path (query) in the parent process.

After a disk wipe:
- The next ingest runs in a fresh subprocess — it sees the clean disk, creates
  a new collection correctly.
- The next query runs in the parent process — its in-memory client still points
  at the collection that no longer exists on disk. It returns stale results or
  raises "no such table."

**Both paths must be isolated.** If you wrap one, wrap both.

### Testing subprocess-isolated code

Each test gets a fresh temp directory and spawns fresh subprocesses:

```python
# tests/conftest.py
import tempfile, pytest

@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "chroma")
    # Each test gets its own dir; each subprocess call sees only that dir.
    # No cross-test state leakage.
```

Integration tests can safely run in parallel because each test's worker
subprocess has its own path scope.

## Why this works

The singleton problem is not a bug in the client library — it is a consequence
of how Python's import system works. A `chromadb.PersistentClient(path=X)` call
that happens at module-level (or the first time a function is called) is cached
in the module's namespace. Subsequent calls in the same process reuse the cached
object, which still holds file handles opened against the old path. A subprocess
fork creates a fresh Python interpreter with no inherited module state, so the
client initializes against whatever is currently on disk.

## Anti-patterns to avoid

- **Wrapping only one path** — the asymmetry trap described above. Both ingest
  and query must run in subprocesses.
- **Importing the client at the top of the worker module** — defeats the purpose.
  The import must happen inside the worker function so it runs after the fork,
  not before.
- **Using `multiprocessing.Process` with `fork` start method** — inherits the
  parent's memory, including the cached client objects. Use `spawn` start method
  or `subprocess.run` instead.
- **"I'll just add a `client.reset()` call"** — verify that `reset()` actually
  closes the underlying file handles and connection pool. Most do not.

## Cross-links

- [[verifier-state-vs-user-state]] — the manual process-boundary protocol for
  cases where subprocess isolation is not yet in place
- [[pre-handoff-clean-state-proof]] — the verification gate that catches
  surviving singleton state before it reaches the user
