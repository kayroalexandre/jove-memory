# Operations

---

## Running

```bash
cp .env.example .env
# fill in OPENROUTER_API_KEY, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD
docker compose up -d
```

The stack is four containers: `api`, `postgres`, `minio`. Postgres and MinIO publish no host
ports; they are reachable only inside the Compose network.

### Health

```bash
curl -s localhost:8888/health | jq
```

Reports the status of the API, Postgres, MinIO, and each model provider separately. A provider
being down does **not** make the service unhealthy — degraded retrieval is still useful
service, and the health endpoint says which layer is degraded.

---

## Connecting a client

### MCP (stdio)

```json
{
  "mcp": {
    "servers": {
      "jove-memory": {
        "type": "local",
        "command": ["docker", "compose", "-f", "/path/to/jove-memory/compose.yml", "exec", "-T", "api", "node", "src/mcp/stdio.mjs"],
        "environment": {
          "OPENROUTER_API_KEY": "{env:OPENROUTER_API_KEY}"
        }
      }
    }
  }
}
```

### MCP (HTTP)

```
http://127.0.0.1:8888/mcp
```

---

## Backup

Three things need backing up, and they are not interchangeable:

| What | How | Notes |
| --- | --- | --- |
| PostgreSQL | `pg_dump` | The memory. Losing this loses everything. |
| MinIO | `mc mirror` or bucket replication | Media bytes. The database has pointers, not content. |
| `.env` | your password manager | Not in git, by design |

```bash
docker compose exec -T postgres pg_dump -U paradigm paradigm > backup.sql
```

**Backups contain the user's actual memory.** They must be encrypted at rest and never
committed. See [SECURITY.md](SECURITY.md).

Restore is `psql`. The system has a migration gate that refuses to start against a schema
version it does not recognise, so restoring into a partially-migrated database fails loudly
rather than corrupting data.

---

## Upgrading the model

Changing the embedding model **invalidates every stored vector**. This is not a toggle.

1. Export everything
2. Change `PARADIGM_EMBED_MODEL` in `.env`
3. Restart
4. Run the reindex command

The system will refuse to search against a database whose vectors are mixed dimensions, rather
than returning quietly wrong results. Mixed-dimension vectors do not fail on insert in
PostgreSQL — they fail on index scan, which means either an error at query time or, worse,
comparing vectors from different spaces as if they meant the same thing. Refusing is the
correct behaviour.

```bash
docker compose exec -T api node src/cli.mjs reindex --confirm
```

---

## Migrating from paradigm-memory

The old installation is **not modified**. Migration reads from an exported snapshot.

1. Export a snapshot from the old server (`.brain` format)
2. `node src/cli.mjs import --snapshot old.brain --workspace main`
3. Verify counts match
4. Switch the client config to point at the new server
5. Keep the old server available for a while, not running side by side

The import re-embeds everything. The old vectors are 384-dimensional; the new ones are 3072.
They are not comparable and are never mixed.

---

## Monitoring

| Signal | Where | Means |
| --- | --- | --- |
| Search latency p95 | `/metrics` | Above ~2s, retrieval is hitting degraded paths |
| Decision provider errors | `/metrics` | Above 0, rerank is being skipped |
| Degraded responses | `debug.degraded` in search output | Which layer fell back |
| DB size | `pg_database_size` | Growth faster than expected suggests reindex churn |
| Threshold drift | GitHub issue | See [THRESHOLDS.md](THRESHOLDS.md) |

---

## Troubleshooting

**Search returns nothing and `debug` shows only BM25**
The embedding provider is failing. Check `/health`. BM25 still works, which is the point — but
semantic search is down.

**Writes fail with a dimension error**
Stale vectors from a previous model. Run `reindex`.

**`pg_search` extension missing**
The image built without it. The system falls back to `tsvector` + GIN automatically and sets
`debug.bm25_engine` to `tsvector`. Ranking is weaker; the rerank stage compensates. See
[ARCHITECTURE.md](ARCHITECTURE.md#bm25-pg_search-with-a-documented-fallback).

**Cross-workspace results never appear**
Check that entity edges exist in `_shared`. The traversal is deliberately fail-closed: no edge
means no result, and the decision provider being down also means no result.

---

## Phase 2 notes — what running the stack actually revealed

These are not in the plan, because a plan cannot know them until the stack runs.

### The container must bind 0.0.0.0, and that is not exposure

The API binds `0.0.0.0` inside the container. The host publishes that port on
`127.0.0.1` only, so the service is unreachable from the network.

Binding `127.0.0.1` *inside* a container makes the port unreachable from the
Docker bridge. The container's own healthcheck fails, the host's published port
fails, and the logs cheerfully report `listening` — which is the worst kind of
bug, because every signal except the two that matter says it is fine.

### `OPENROUTER_API_KEY` is not required at boot

The stack has to start, and serve health, before any key exists — that is the
whole point of Phase 2. A missing key makes every provider-backed operation fail
at its call site, where the error is actionable, rather than at boot where it
only says something is unset. `/health` reports the absence.

### Provisioning and migrating are one operation

`provisionWorkspace` creates the database *and* migrates it. An earlier version
had them separate, which produced a container that crash-looped on a database
that existed but had no schema — the version guard correctly refused to start,
and nothing in the logs pointed at the provisioning call that caused it.

### Pool sizing is a real constraint

Each workspace gets its own pool, so the total is `workspaces ×
POSTGRES_POOL_MAX_PER_WORKSPACE`. PostgreSQL's default `max_connections` is 100.
The default here is 4, not 10, and the integration suite runs serially for the
same reason: forty pools opening at once exhaust the server, and that failure
looks like a database fault rather than a resource-management one.

---

## Phase 3 notes — what the four layers revealed

### pgvector cannot index 3072 dimensions

`docs/ARCHITECTURE.md` specified HNSW. pgvector 0.8.6 refuses it:

```
ERROR:  column cannot have more than 2000 dimensions for hnsw index
```

`google/gemini-embedding-2` is 3072 and the width is not negotiable without re-embedding
everything (ADR-005). So the vector arm is an **exact** search — a sequential scan computing
cosine per row.

What that costs: latency linear in corpus size. Acceptable at a few thousand memories, which is
what a personal system holds. Not acceptable at a million.

What it does not cost: accuracy. An exact search returns the true nearest neighbours, so the
Phase 6 rerank benchmark measures something unaffected by this.

Escape hatch: Gemini Embedding 2 accepts 128–3072, and 1536 or 2048 permits HNSW. That is a data
migration, not a config edit. Decided when the corpus needs it.

### The distance floor defaults to *no floor*

`minSimilarity` defaults to `null`, which applies no floor — so the vector arm returns the K
nearest items to **any** query, including one about something entirely absent from memory. A
nearest-K query has no notion of "close enough": the K-th neighbour comes back whether its
similarity is 0.9 or 0.02.

That is the correct default for a build whose floor is not yet calibrated, and it is why "nothing
relevant is stored" and "the index is broken" are indistinguishable without one. A floor of zero
is a real floor and is not the same as no floor; the code distinguishes them and so should a
caller reading a response. Added to `docs/THRESHOLDS.md` as a value to measure.

### Graph traversal is bounded, and the bound is correctness

`maxDepth` is capped at 3. A memory graph will have cycles the moment two memories mention the
same entity, and an unbounded recursive walk over a cycle is a query that never returns. The
recursive term also carries a path array, so a walk cannot revisit a node it has already passed
through.

There is deliberately **no** `id <> ALL(seeds)` filter on the final result. With ten seeds — which
is what arms 1 and 2 return — it would exclude every item in the corpus. An earlier version had
one, and the symptom was a graph arm that always reported zero hits against a corpus it could
reach. Overlap between arms is what RRF exists to reward.

### The `search_vector` column is generated, and tags reach it as JSONB text

```sql
setweight(to_tsvector('english', coalesce(tags::text, '')), 'B')
```

`array_to_string(ARRAY(SELECT jsonb_array_elements_text(tags)), ' ')` is the obvious version and
does not work: a generated column may not contain a subquery. The JSONB serialisation is
immutable, which a subquery-built expression is not guaranteed to be. The tokens come out the
same — JSON punctuation is not word material to the text parser.

### `store.mjs` did not own all the SQL, and the comment said it did

The header claimed to be the only module in the project writing SQL. Two siblings legitimately
do: `migrate.mjs` applies DDL, `pool.mjs` runs the `CREATE DATABASE` and `pg_stat_activity`
queries that one-database-per-workspace depends on. Those are statements about *databases*, not
about *memories*, which is the line that matters.

The invariant test now asserts the accurate claim and a second test asserts the comment does not
overstate itself again. A comment that claims more than the code delivers is the kind of thing
that gets trusted.

---

## Phase 4 notes — cloud embeddings

### The width check is the whole design

`google/gemini-embedding-2` is 3072 dimensions and the column is `vector(3072)`. The client
refuses any vector of any other width, and the refusal names the model, both numbers, and the
offending text.

This is the failure that never surfaces as an error. A 1536-wide vector in a 3072 column either
gets stored and produces nonsense distances that look like mediocre ranking, or is rejected by
pgvector three layers away with a message naming neither the text nor the model that produced it.
Catching it in the client turns a silent wrong answer into one line that says what happened.

It is also why `PARADIGM_EMBED_DIMENSIONS` is not a runtime tuning knob. It is the column width
from migration 0002. Changing it means re-embedding everything, because two models do not share
a vector space (ADR-005).

### A base64 string where floats were requested is a hard error

`encoding_format: "float"` is sent explicitly. The default is currently float, so this is belt
and braces — but a provider that ignored the request and returned base64 would be decoded as a
float array, producing numbers of the wrong length. Plausible values, wrong answer, no error.
The client checks the type and refuses.

### `input_type` is a request field, not a per-input field

NVIDIA's `nemotron-3-embed-1b` requires `input_type` of `query` or `passage`, and the same string
embedded as one and as the other lands in meaningfully different places. A batch mixing queries
and passages cannot be sent in one request at all, because the field is per-request. The client
refuses rather than picking one type for the whole batch, which would embed documents as queries
and degrade every hit in a way nothing would report.

`google/gemini-embedding-2` ignores the field. It is sent only when asked for, and only to a model
that wants it.

### Missing provider is not a failed provider

`debug.semantic_error` and `debug.semantic_configured` are separate fields, and the distinction is
load-bearing:

| State | `semantic_error` | `semantic_configured` | What it means |
| --- | --- | --- | --- |
| Working | `null` | `true` | Four layers |
| Key issued, provider down | the reason | `true` | Retry, alert — something is wrong |
| No key | `null` | `false` | Nobody has issued a key yet |

Reporting the third as an error would train a reader to ignore the second, which is the failure
mode this is designed to prevent.

### The health check still makes zero outbound requests

The Phase 2 gate held, and Phase 4 made it more important rather than less. A health check that
embedded a test string to prove the key works would spend money and burn rate-limit on every
container restart, and every orchestrator's liveness probe would do it on a schedule.

So the key is checked for presence, never for validity. `verified: false` is permanent and
documented as such. The first real use is what proves it works, and a failure there is reported by
the search that hit it.

Verified with a key present:

```
status: ok
openrouter: configured, verified: false
indexing: google/gemini-embedding-2, 3072 dims, per-workspace coverage
outbound requests: 0
```

### Index completeness is not a health signal

A corpus that is 30% unembedded retrieves perfectly well, on three layers instead of four. It is
reported under `indexing`, deliberately outside `dependencies` — calling it degraded would make
`/health` noisy and train a reader to ignore it.

`ratio` is `null` for an empty corpus, not `0`. "Nothing is missing because there is nothing" and
"nothing is indexed" are different states, and division reports the first as a perfect score.

### An item is stored even when it cannot be embedded

The write happens first. A memory with no vector is still a memory, and blocking the write on a
provider blip would lose the thing the user asked to remember. `embedItem` returns a result object
rather than throwing, because a write path needs to know the write succeeded and the embed did
not — two separate facts.

### What Phase 4 could not verify

The gate has three parts and one is not closable here:

1. ~~A text query returns results ranked by vector similarity~~ — verified
2. ~~No `semantic_error` in the response~~ — verified
3. Image query retrieves text items and text query retrieves image items, same index — **not
   verifiable without a key**

Part 3 is a property of Google's embedding space: whether the model places an image near the text
describing it is a fact about the model, and a fake embedder has no such property. What the tests
assert instead is the *mechanism* — both produce a 3072-wide vector, both are written to
`memory_item_vectors`, exactly one table in the database holds a `vector` column, and both are read
back by the same distance query. The remaining step is one real request.

This is recorded as unverified rather than assumed. Closing it needs an OpenRouter key, which has
not been issued to this environment.
