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

---

## The credential at rest

The settings form at `/settings` writes the OpenRouter key into the database. It is stored
**encrypted**, and the property that makes the encryption mean something is this:

> **The key that encrypts the credential is not in the database.**

| Half | Where | Who controls it | Exposure |
| --- | --- | --- | --- |
| Ciphertext, nonce, auth tag | `provider_credentials` in the workspace database | this application | reachable from the container network; no host port |
| Master key | a 32-byte file, mode 600, outside the repository | the operator | not mounted read-only into anything |

Consequences, stated plainly:

- A database backup, a replica, or a `pg_dump` pasted into an issue yields **ciphertext**.
- The master key file alone yields **nothing usable** — it is a key, not a credential.
- An attacker with **both** recovers the key. No single-place encryption changes that, and
  this document does not claim otherwise.

### Why AES-256-GCM

Because of the authentication tag. CBC under a wrong key produces garbage that decrypts
"successfully", and that garbage is then sent to a provider as an API key. GCM refuses: a
tampered row, a corrupted byte, or a replaced master key is an error at the first
decryption.

### Why the fingerprint is keyed

`credentials_audit` and `provider_credentials` carry a 16-character fingerprint used to
answer "is this the same key as before?". It is an **HMAC of the value under the master
key**, not a hash of the value and not a hash of the ciphertext:

- A hash of the value would let anyone holding the database test candidate keys against
  it. With the master key as the HMAC key, they cannot — and if they have the master key
  they can decrypt outright, so the fingerprint adds nothing they did not already have.
- A hash of the ciphertext changes on every save, because GCM uses a fresh nonce per
  write. That makes "unchanged" unreachable, so the form would report a change every time
  an unchanged key was saved, and a report that is always "changed" is a report nobody
  reads.

### What is deliberately absent

- **No last-four field.** Four characters narrows a key space further than it feels like,
  and nothing here needs it that a fingerprint does not serve.
- **No diff in the audit trail.** A diff of two keys is not reconstructible and is a leak
  waiting for a use case. Operations and timestamps only.
- **Nothing external on the page.** No script, stylesheet, font, icon or analytics from
  any origin, enforced by a `default-src 'none'` CSP rather than asserted in a comment.
  A page that accepts a credential and loads a script from a CDN has handed that
  credential to the CDN.
- **No way to read the key back.** The form is write-only. After saving, the field is
  cleared and the response carries a fingerprint. A settings page that can display a
  secret is a settings page that puts it in a screenshot.

### What is not protected

- An attacker who can read the database **and** the filesystem as the operating user.
- A compromised host. At that point the key is recoverable.
- The master key in a `pg_dump` — it is not there, which is the point.

### Per-workspace

Credentials are per-workspace like everything else (ADR-003). A key saved from the
settings form lives in the workspace the service was started for, and is not visible from
another. That is the same rule that keeps one workspace's memories out of another's
searches, applied to a secret rather than to a memory.
