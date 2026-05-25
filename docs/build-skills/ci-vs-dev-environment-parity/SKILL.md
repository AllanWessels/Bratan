---
name: ci-vs-dev-environment-parity
description: Before pushing to CI, validate that your local test run is representative — three predictable axes diverge (gitignored fixtures, dev-only ports, dev-only env vars) and each has a deterministic fix.
metadata:
  tags: [process, testing, ci, environment, discipline]
---

# CI vs Dev Environment Parity

## When to use

- You are about to push a branch that has CI hooks (GitHub Actions, pre-push
  hooks, etc.).
- A test passes locally but you suspect it might not in CI.
- You are writing a new test that touches files on disk, makes HTTP requests
  to localhost, or relies on environment variables.
- CI is reporting failures you cannot reproduce — before labeling them flakes,
  check all three axes below.

## When NOT to use

- The test failure reproduces on a fresh `bash -l` shell with no pre-existing
  dev server and no gitignored files. That is a real bug, not a parity issue.
- Pure unit tests with no I/O and no env-var reads. These are immune to the
  three divergence axes.

## The three axes of divergence

Every "works on my machine" CI failure has one of three origins. Check all
three before pushing:

### Axis 1 — Gitignored fixtures

Local dev may have files in `corpus/`, `.env`, `data/`, `secrets/`, or any
other gitignored directory. CI starts from a clean checkout; those files are
not there.

**Symptoms:** `FileNotFoundError`, `No such file or directory`, Playwright
test asserting "document loaded" fails because the ingest step found nothing.

**Fix:** Any test that asserts a file on disk either:
- Drops the fixture in `beforeAll` / `setup` and cleans it up in `afterAll`
  / `teardown`, OR
- Skips with a descriptive message when the fixture is absent:
  ```python
  if not Path("corpus/").exists() or not list(Path("corpus/").glob("*.pdf")):
      pytest.skip("corpus/ has no PDFs — gitignored user data, skipping in CI")
  ```

### Axis 2 — Dev-only ports

Playwright specs that target `localhost:5173` (Vite dev server) pass locally
because dev is already up. CI runs `vite build && vite preview` on `:4173`,
or a dedicated test server. The spec hits `ERR_CONNECTION_REFUSED`.

**Symptoms:** All Playwright tests fail with connection refused or time out at
navigation. Passes 100% of the time locally.

**Fix options (in order of preference):**
1. Configure `playwright.config.ts` `webServer` to start the correct server
   for CI and point `baseURL` at it. Do not hard-code `:5173` in specs.
2. For specs that genuinely require the live dev server (HMR verifiers, hot-
   reload checks), gate them off in CI:
   ```ts
   test.skip(!!process.env.CI, "Requires live Vite dev server — not available in CI")
   ```
3. Never rely on `reuseExistingServer: true` with a dev server you happen to
   have running. That papers over the divergence instead of fixing it.

### Axis 3 — Dev-shell environment variables

`PYTHONPATH`, `BRATAN_PROJECT_ROOT`, `NODE_ENV`, `VENV_PATH`, API keys set in
`.zshrc`, or by a running `uvicorn`/`fastapi` process — these are not present
in CI subprocess invocations.

**Symptoms:** `ModuleNotFoundError: No module named 'scripts.query_worker'`,
`KeyError: 'BRATAN_PROJECT_ROOT'`, unexpected `None` for a config value that
was always set in dev.

**Fix:**
- Run the test suite in a clean shell before pushing:
  ```bash
  bash -l -c 'cd /path/to/project && uv run pytest tests/ -x'
  ```
  If that fails and `pytest tests/` from your normal shell passes, you found
  a parity bug.
- Make environment variables explicit: read from `.env` via `python-dotenv`
  or equivalent; do not rely on ambient shell state.
- For `PYTHONPATH` specifically: set it in `pyproject.toml` via
  `[tool.pytest.ini_options] pythonpath = ["."]` rather than in the shell.

## Pre-push checklist

Run these before every push to a branch with CI:

```bash
# 1. Clean-shell pytest — catches Axis 3
bash -l -c 'cd $(pwd) && uv run pytest tests/ --tb=short'

# 2. Playwright against the CI server config — catches Axis 2
CI=true npx playwright test --reporter=line

# 3. Verify gitignored fixtures have proper skips — catches Axis 1
grep -rn 'corpus/\|data/\|secrets/' tests/ e2e/ | grep -v skip | grep -v beforeAll
# Review each hit: does it guard against missing fixtures?
```

## Why this works

"Works on my machine" has three predictable, structural origins. Each one is
caused by an assumption that is true in dev and false in CI. Treating CI
failures as flakes when they are actually parity bugs wastes time and
obscures real signal. Each axis has a deterministic fix; together they cover
the majority of CI-only failures encountered in practice.

The clean-shell pre-push check is the single highest-ROI step: it costs 30
seconds and catches Axes 2 and 3 before the push.

## Anti-patterns to avoid

- **Treating deterministic CI failures as flakes.** If a failure reproduces
  on a fresh checkout, it is not a flake. Check all three axes before
  re-running.
- **`reuseExistingServer: true` as a permanent config.** It is useful during
  local development; it is a divergence trap in CI because it hides a missing
  webserver setup.
- **Fixing one axis without checking the others.** Adding a fixture guard
  (Axis 1) doesn't help if the spec is also hitting the wrong port (Axis 2).
  Sweep all three.
- **Leaving dev-shell env vars in the CI environment.** CI runners are often
  shared; leaking dev env vars into CI (via cache or artifact) is a security
  risk as well as a parity problem.
- **Hard-coding localhost ports in specs.** Prefer `baseURL` from
  `playwright.config.ts` so the port is configurable per environment.

## Cross-links

- [[pre-handoff-clean-state-proof]] — the clean-state proof checklist is the
  UI-layer analogue of this skill: both exist to prevent "it works for me"
  claims that don't survive a fresh environment
- [[verifier-state-vs-user-state]] — the process-restart requirement addresses
  the same divergence pattern at the in-process state layer
