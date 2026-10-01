# jove-memory

Persistent, self-hosted memory server for coding agents. MCP-native, PostgreSQL-backed,
cloud-model-only — no local model inference, no local embedding runtime.

Docker Compose stack: one API container, one PostgreSQL, one MinIO. Every model call goes
out to a cloud provider through a single API key.

---

## What it is

`jove-memory` is a fork of [paradigm-memory](https://github.com/infinition/paradigm-memory)
(Apache-2.0) with the storage substrate and the model layer replaced. The MCP tool surface is
preserved so existing clients keep working; everything behind it is different.

| | paradigm-memory (upstream) | jove-memory |
| --- | --- | --- |
| Store | SQLite | PostgreSQL 18 |
| Text search | FTS5 | `pg_search` (BM25) |
| Vector search | none (cosine in JS) | pgvector HNSW |
| Graph | none | entity edges + recursive CTE |
| Temporal | `expires_at` only | bitemporal (`occurred_at` / `recorded_at` / `invalidated_at`) |
| Embeddings | local ONNX / Ollama | cloud, multimodal |
| Inference | local Qwen via Transformers.js | cloud |
| Decisions | heuristics | calibrated decision model |
| Deployment | local binary | Docker Compose |
| Media | none | S3 (MinIO) |

**One vector space.** `google/gemini-embedding-2` places text and images in the same
embedding space, so a text query retrieves images and an image retrieves text. No dual index.

**No local models.** The container holds no model weights and no ML runtime. Memory footprint
is the Node process plus the database.

---

## Architecture at a glance

```
   coding agent
        │  MCP
        ▼
  ┌──────────────────────┐
  │  jove-memory API     │──────► MinIO (S3: bytes of media and attachments)
  │  (Node 22)           │
  └──────────┬───────────┘
             │
   ┌─────────┴──────────────────────────────┐
   │                                         │
┌──▼──────────────────────┐        ┌─────────▼──────────┐
│  PostgreSQL 18           │        │  OpenRouter        │
│  vector + BM25 + graph   │        │  embeddings        │
│  + temporal              │        │  decisions         │
│  one database per        │        │  inference         │
│  workspace + _shared     │        └────────────────────┘
└──────────────────────────┘
```

---

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why each technology and model was chosen |
| [docs/PLAN.md](docs/PLAN.md) | Phased implementation plan with gates |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and what must never reach a public repo |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running, backing up, calibrating |
| [docs/THRESHOLDS.md](docs/THRESHOLDS.md) | How decision thresholds get calibrated automatically |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision records |

Progress is tracked in GitHub Issues. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Apache-2.0, matching the upstream project.

`jove-memory` is a derivative work of [paradigm-memory](https://github.com/infinition/paradigm-memory)
by Fabien POLLY, also Apache-2.0.
