# Architecture

This document records **why** each technology and model was chosen. For *what* gets built and
in what order, see [PLAN.md](PLAN.md).

---

## 1. Storage: one PostgreSQL, four access layers

### Why PostgreSQL

Upstream stores everything in SQLite and computes vector similarity in JavaScript, in a loop,
over a JSON blob column. That does not scale past a few thousand items, cannot do hybrid
retrieval, and cannot do graph traversal.

`jove-memory` uses PostgreSQL 18 because the four retrieval strategies this system needs all
live in one engine, in one transaction, against one set of indexes:

| Layer | Implementation | What it contributes |
| --- | --- | --- |
| Vector | `pgvector`, exact search (no ANN index — see below) | Semantic similarity |
| Text | `pg_search` (ParadeDB) | True BM25, keyword-exact matches |
| Graph | `entity_edges` + `WITH RECURSIVE` | Relationship traversal |
| Temporal | bitemporal columns | "What was true when" |

SQLite cannot do any of the last three. Qdrant can do vectors but not relational or BM25.
Neo4j can do graphs but not vectors well. Running four databases would mean four backups, four
failure modes, and cross-database consistency problems on every write.

### BM25: `pg_search`, with a documented fallback

`pg_search` (ParadeDB) provides real BM25 ranking, which PostgreSQL's built-in `ts_rank` does
not. It is an extension that must be present at database creation time.

**Fallback:** if the extension fails to install on a given host, the system falls back to
`tsvector` + GIN. That path is fully supported and requires no code change, but ranking
quality is weaker. The difference is measured by the Phase 6 gate (see PLAN.md), because a
weaker BM25 makes the rerank stage carry more weight.

### Graph without Apache AGE

Apache AGE would give Cypher over the entity edges. It is not used. The traversal this system
needs — "what else mentions this entity, and what is reachable from there" — is expressible
with `WITH RECURSIVE` in about fifteen lines, and adding an extension to maintain is a real
cost for no gain at this data scale.

**Mitigation:** if traversal depth or edge count makes recursive CTEs the bottleneck, AGE can
be added later without changing the `entity_edges` table shape.

### Temporal: bitemporal, not expiry

Upstream has one `expires_at` column, which answers "is this stale now" and nothing else.

`jove-memory` records two independent times per fact:

- `occurred_at` — when the fact became true in the world
- `recorded_at` — when the system learned it
- `invalidated_at` — when the system learned it stopped being true

A fact that stopped being true is **not deleted**. It is invalidated. This is what makes "what
did I believe about X in March" answerable, and it is also what makes consolidation safe:
when `memory_dream` merges two facts, the originals stay queryable as history.

---

## 2. Workspace isolation that is not naive

Each workspace gets its own **database**, not a schema. A schema in a shared database shares
a connection pool, shares a memory budget, and is one `search_path` mistake away from leaking.

The system is still allowed to know that other workspaces exist. Cross-workspace retrieval is
only ever reached through a real entity edge stored in the `_shared` database:

```
jove-memory
├── main            database — workspace memory
├── geos-acervo     database — workspace memory
└── _shared         database — entity edges that cross workspace boundaries
```

A query in workspace A cannot reach workspace B by scanning. It can only reach B if there is an
entity edge in `_shared` linking the two, and if the decision model scores that edge above the
cross-workspace threshold. Every result carries the `workspace` it came from, so the client
always knows what it is looking at.

This is the difference between isolation and amnesia.

---

## 3. Model layer: one key, three surfaces

Everything goes through OpenRouter. One key, one billing account, one place to manage.

### Why OpenRouter as the default

- One credential instead of four
- Provider routing and failover handled upstream
- Cost and usage visible in one dashboard
- Switching models is a config change, not a code change

NVIDIA remains supported as a direct provider for embeddings, because the plan that motivated
this fork called for it. It sends `input_type` (`query` or `passage`), which the generic
OpenAI-compatible path does not, so it has its own adapter rather than being forced through
the generic one.

### Embedding: `google/gemini-embedding-2`

| Property | Value |
| --- | --- |
| Dimensions | 3072 (adjustable 128–3072) |
| Modalities | text and images in **one** embedding space |
| Context | 8,192 tokens |
| Price | $0.20/M text tokens, $0.45/M image tokens |

**The reason for this choice is single-space multimodal retrieval.** A text query retrieves
relevant images and an image query retrieves relevant text, with no second index, no second
embedding space, and no routing logic to decide which index to hit. The alternative — a
separate text index and a separate multimodal index — doubles the index maintenance, doubles
the migration surface, and needs a query classifier to pick between them.

**Constraint:** the embedding space is fixed once an index exists. Changing the model means
re-embedding everything, because Gemini Embedding 2 and Voyage Multimodal 3.5 do not share a
vector space. Model choice is therefore a Phase 9 decision, not a runtime toggle.

**The cost of 3072 dimensions, measured:** pgvector 0.8.6 refuses an HNSW index above 2000
dimensions.

```
ERROR:  column cannot have more than 2000 dimensions for hnsw index
```

So the vector arm runs an **exact** search — a sequential scan computing cosine distance per
row. Latency is linear in corpus size, which is fine at the few thousand memories a personal
memory system holds and not fine at a million. Ranking *quality* is unaffected: an exact search
returns the true nearest neighbours, and Phase 6's benchmark measures accuracy, not latency.

The escape hatch is a narrower embedding. Gemini Embedding 2 accepts 128–3072, and 1536 or 2048
would permit HNSW. That is a data migration rather than a config edit, so it is a decision to
make when the corpus needs it rather than in advance. Recorded in `0002_retrieval.sql` next to
the absence, so the next person does not assume it was forgotten.

**Fallback:** if the model is unavailable, the system degrades to BM25-only retrieval and
reports it in the `debug` block of the search response. It does not silently return worse
results without saying so.

### Inference: `qwen/qwen3.8-flash`

| Property | Value |
| --- | --- |
| Price | $0.15/M input, $0.47/M output |
| Context | 1,000,000 tokens |
| Max output | 131,072 tokens |
| Released | 2026-08-26 |
| Modalities | text, image, PDF, video in; text out |

This is the inference default because it is the cheapest current flash-tier model that is
still recent and multimodal, which matters for two reasons:

1. **Cost.** At $0.15/M in and $0.47/M out, it is roughly 2× cheaper than Gemini 3.5 Flash
   Lite and 5× cheaper on input than Gemini 3.7 Flash. Over the memory system's volume, that
   difference is not noise.
2. **Multimodal.** Media ingested into memory needs describing. A text-only inference model
   would force a separate vision call for every image.

`deepseek/deepseek-v4-flash` is the configured fallback inference model.

### Decisions: `upstage/solar-decide`

| Property | Value |
| --- | --- |
| Price | $0.05/M input, **$0/M output** |
| Context | 524,288 tokens |
| Schema | System One (`noul`, `choice`, `score`) |
| Served via | OpenRouter Decisions API |

A decision model is not an LLM. It receives a `state` plus typed questions and returns typed
answers with calibrated probabilities and a `confidence` value. It does not generate prose and
cannot be asked to.

This is why it is used for six specific jobs and not for summarization:

| Job | Primitive | Decides |
| --- | --- | --- |
| Write gate | `noul` | Is this content worth storing? |
| Deduplication | `score` + `noul` | Same entity, or conflict? |
| Consolidation trigger | `noul` | Is this consolidation proposal worth executing? |
| Reranking | `noul` per pair | Which candidates actually answer the query? |
| Cross-workspace relevance | `noul` | Is this other-workspace item relevant here? |
| Intent routing | `choice` | Search, consolidate, or neither? |

**Why this model rather than `typesafe/jev-1.13`:** both use the identical schema, so they are
drop-in swappable. Solar Decide has 524k of context against Jev's 32k, at a comparable price
($0.05 vs $0.042). The larger context removes the most awkward constraint in the design: reranking
a shortlist in one request instead of one request per candidate pair.

**Known limitation:** Solar Decide is listed as beta by Upstage. The system treats any decision
model as replaceable, pins the exact model id in config, and degrades to unranked RRF ordering if
the call fails. See [THRESHOLDS.md](THRESHOLDS.md).

**Non-negotiable property:** if the decision model is unavailable, retrieval still works. It
returns RRF-ordered results without reranking and says so in the response. No memory operation
ever depends on a successful decision call.

---

## 4. Retrieval: four strategies, fused, then reranked

```
query
  │
  ├─ decision model → intent (choice): search | consolidate | none
  │
  ├─ four parallel arms
  │    ├─ vector    : pgvector exact cosine, top-K (no ANN: 3072 > pgvector's 2000-dim HNSW limit)
  │    ├─ BM25      : pg_search, top-K
  │    ├─ graph     : entity traversal from the query's entities
  │    └─ temporal  : facts valid in the requested window
  │
  ├─ RRF fusion (reciprocal rank fusion — no score normalization needed)
  │
  ├─ decision model → rerank top-N (noul per candidate)
  │
  ├─ cross-workspace expansion, only via _shared entity edges,
  │  only above the cross-workspace threshold
  │
  └─ pack within token budget, each item carrying provenance
```

**Why RRF before rerank:** RRF combines rankings without needing comparable scores across
strategies. Cosine similarity and BM25 are on different scales; normalizing them requires
per-query calibration that fails badly on small result sets. RRF only needs ranks.

**Why rerank at all:** the fast arms retrieve what *shares vocabulary or embedding space* with
the query. They cannot tell whether a candidate actually answers the question. The decision
model reads each candidate against the query and returns a calibrated probability. Measured
effect on a comparable benchmark: top-1 accuracy 5% → 18%, top-10 38% → 62%.

**Every result carries provenance:** which workspace, which arm surfaced it, the fused rank,
the rerank score, and whether it came from another workspace. A client can always tell where
a piece of memory came from and how confident the system is about it.

---

## 5. Media and S3

Media bytes never go into PostgreSQL or into the vector store. They go to S3-compatible object
storage; the database keeps a pointer, the sha256, the MIME type, and the extracted text.

`docker compose` ships MinIO, which is S3-compatible and runs locally. The code speaks plain
S3, so pointing at AWS S3, Cloudflare R2, or Backblaze is a config change.

**Checksums are computed locally and stored in the database.** The S3 ETag is never trusted as
integrity proof, because multipart uploads produce ETags that are not content hashes.

---

## 6. What is deliberately not built

- **Apache AGE.** See section 1.
- **A second vector space.** See section 3.
- **Local embedding or inference fallback.** A local fallback is a whole second runtime to
  maintain and test. When the cloud path fails, the system degrades to BM25 rather than
  silently running a model nobody configured.
- **Multi-tenant authentication.** Single-user deployment. The MCP server binds to localhost.
  Anything beyond that is a separate project.

---

## 7. Module boundaries

The upstream `memory-service.mjs` is 1408 lines and mixes storage, retrieval, consolidation, and
MCP transport in one file. This project refuses to repeat that. Modules are split so each is
testable in isolation, and the implementation order in PLAN.md follows the dependency graph
rather than feature appeal.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `store/` | Postgres access, migrations | pg only |
| `retrieval/` | The four arms, RRF | `store/`, embedder |
| `decisions/` | Decision model client, calibration | decision provider only |
| `ingest/` | Chunking, extraction, media | store, embedder, inference |
| `consolidate/` | Propose, execute, invalidate | decisions, inference |
| `mcp/` | Tool surface | everything above |
| `api/` | REST surface | everything above |

No module reaches into another module's internals. `store/` is the only thing that writes SQL
about memories — `migrate.mjs` applies DDL and `pool.mjs` runs the `CREATE DATABASE` and
`pg_stat_activity` queries the one-database-per-workspace design needs, but those are statements
about databases, not about memories.
