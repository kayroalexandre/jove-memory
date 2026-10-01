# Security

This repository is **public**. Everything committed here is world-readable from the moment it
is pushed.

The failure mode this document exists to prevent: a memory system holds a user's project
structure, decisions, credentials-adjacent notes, and API keys. A single leaked key or a
single leaked memory dump is a real incident.

---

## Rules

### Never commit

| Thing | Why |
| --- | --- |
| `.env` | Contains the OpenRouter key and database passwords |
| Any `*.key`, `*.pem`, `*.p12`, `*.pfx` | Credentials |
| `service-account*.json`, `credentials.json` | Cloud credentials |
| SQLite files, `.brain` snapshots | **Memory contents.** These are the user's actual context |
| `pgdata/`, `minio-data/` | Database volumes, may contain media |
| `coverage/`, `*.log` | May embed request payloads or connection strings |
| `node_modules/` | Supply chain surface |

All of the above are in `.gitignore`. `.dockerignore` covers the build context separately so
secrets never reach an image layer.

### Never log

| Thing | Why |
| --- | --- |
| The OpenRouter key | Any log with it is a leak |
| Request payloads to model providers | Memory content leaves the machine |
| Response bodies from model providers | May echo back memory content |
| Connection strings with passwords | Appears in driver error messages by default |

**Mitigation:** the HTTP client used for provider calls has a redaction layer that scrubs
`authorization` headers and does not retain request or response bodies. Error objects carry a
status code and a provider-supplied message, never a payload. There is a test that fails the
build if a redaction rule is removed.

### Never put memory content in an issue, a commit message, or a doc

When a gate needs real data to be measured, the measurement runs locally and **the numbers go
in the issue**. The data does not. Example: "top-10 improved from 38% to 62% on a 40-query
set" is safe. "the query was `how do I fix the postgres connection in geos-acervo`" is not.

---

## Pre-commit protection

The repository has a secret scanner in the commit path that blocks:

- High-entropy strings matching known key formats (`sk-`, `ghp_`, `gho_`, AWS `AKIA`,
  `xoxb-`, private key headers)
- Anything matching `OPENROUTER_API_KEY=<non-empty>` outside `.env.example`
- Files that would be ignored but are being added explicitly (`git add -f` on a `.env`)
- SQLite and snapshot files

The scanner runs before the commit object is created, so a rejected secret never reaches the
object database. Bypassing requires editing the hook, which leaves a visible diff.

**GitHub side:** push protection and secret scanning are enabled on the repository, so even a
bypass that got through locally would be caught before it reached a pull request.

---

## Runtime security posture

### Single-user, localhost-bound

This is a personal memory server, not a multi-tenant service.

- The MCP and REST servers bind to `127.0.0.1`, not `0.0.0.0`
- PostgreSQL and MinIO ports are **not** published to the host at all. They are reachable only
  from inside the Compose network
- There is no authentication layer, because there is no network exposure to authenticate

**If this ever needs to be reachable from another machine, that is a security change requiring
a threat model, not a config tweak.** See the open question in GitHub Issues.

### Credentials

- The OpenRouter key is read from the environment only
- It is never written to the database, never written to a file, never included in a snapshot
  export
- Postgres and MinIO passwords are generated at first run and live only in `.env`, which is
  ignored
- `.env.example` contains **only** empty placeholders

### The database holds sensitive content

Everything in PostgreSQL is the user's actual working memory. This means:

- Backups are as sensitive as the database
- `docker compose down -v` destroys it permanently
- The export/import feature must never emit an archive containing secrets, and there is a test
  asserting that

---

## Dependency risk

Dependencies are pinned to exact versions in `package-lock.json`. Automated dependency updates
open a pull request rather than merging directly, so a compromised package cannot land silently.

The fork removes `@huggingface/transformers`, which was the largest dependency in the upstream
project (it pulls ONNX Runtime and model weights). Removing it shrinks the attack surface
substantially, which is a side benefit of the no-local-models decision.

---

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting
on this repository.
