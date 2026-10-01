# Contributing

This is a solo-maintained project with a public repository. Conventions exist so that the
commit history stays useful and so nothing sensitive gets published by accident.

---

## Branch and commit

- `main` is the default branch and is protected
- Work goes through pull requests, one phase at a time
- Commit messages describe **why**, not what. The diff already says what.
- Reference the phase: `Phase 3: add pg_search index` not `fix stuff`

---

## Secrets

Before every commit, the pre-commit hook scans for credentials. It is not optional.

Never commit: `.env`, keys, certificates, SQLite files, `.brain` snapshots, database volumes,
or logs. The full list and the reasoning is in [docs/SECURITY.md](docs/SECURITY.md).

If the scanner blocks something you believe is a false positive, do not bypass it. Fix the
pattern that triggered it.

---

## Keeping documentation honest

Documentation that contradicts the code is worse than no documentation, because it is trusted.
Three rules:

1. **A phase is not done until its gate passed.** Do not tick a box in `PLAN.md` because the
   code looks complete. The gate is a measurement.
2. **When behaviour changes, the change lands with the commit that caused it.** A new model, a
   new threshold, a new limitation: update `docs/` in the same commit.
3. **Superseded decisions get a new ADR**, not an edit to the old one. `DECISIONS.md` is a log,
   not a summary.

---

## Progress tracking

GitHub Issues is the source of truth for what is in progress. The plan document describes the
shape of the work; the issues describe the actual state of it.

- One issue per phase
- Gate results are recorded in the issue when measured, as numbers, never as data
- Open issues are closed when the phase's gate passes, with the numbers in the closing comment

---

## Testing

- Every module tests without the others running
- Anything that touches a model provider is tested against a recorded fixture, not the live API,
  so the suite never costs money
- One test is mandatory for the secret-redaction layer. Removing a redaction rule fails the build.
- One test asserts that export never emits a secret.

---

## Project layout

```
jove-memory/
├── src/
│   ├── store/        PostgreSQL access. The only place SQL exists.
│   ├── retrieval/    the four arms, RRF fusion
│   ├── decisions/    decision model client and calibration
│   ├── ingest/       chunking, extraction, media
│   ├── consolidate/  propose, execute, invalidate
│   ├── mcp/          MCP tool surface
│   └── api/          REST surface
├── docs/             see README for the index
├── compose.yml       api, postgres, minio
└── .env.example      placeholders only
```

No module reaches into another module's internals.
