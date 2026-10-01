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
