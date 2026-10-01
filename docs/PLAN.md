# Implementation plan

Ten phases. Each phase ends in a gate that is **measured, not asserted**. A phase is not done
because the code exists; it is done because the gate passed.

Phases run in order. Each depends only on the ones above it.

---

## Phase 1 — Store behind an interface

**Deliverable:** `store/` implemented on PostgreSQL, exposing the same method surface the
upstream SQLite store exposes, plus migrations.

**Why first:** everything else calls the store. If the store is wrong, every failure
downstream is ambiguous.

**Gate:**
- Export the current SQLite data to snapshot, import into PostgreSQL, export again, diff the
  two snapshots. **Byte-identical.**
- Every method in the upstream surface returns the documented shape.

---

## Phase 2 — Compose stack, zero external calls

**Deliverable:** `docker compose up` brings up API, PostgreSQL, MinIO. Nothing else.

**Gate:**
- Stack starts clean on a fresh machine
- `/health` returns healthy for API, Postgres, MinIO
- **Zero outbound HTTP requests** during startup and health check

---

## Phase 3 — Four retrieval layers

**Deliverable:** vector, BM25, graph, temporal all queryable and fused with RRF.

**Gate:**
- A search response's `debug` block shows all four contributions with real values, not zeros
- Same query against the same data returns the same ordering across 10 runs

---

## Phase 4 — Cloud embeddings

**Deliverable:** OpenRouter embedder, multimodal, `google/gemini-embedding-2`.

**Gate:**
- A search with a text query returns results ranked by vector similarity
- **No `semantic_error`** anywhere in the response
- Image query retrieves text items, and text query retrieves image items — **same index**

---

## Phase 5 — Decision client and write gate

**Deliverable:** `decisions/` client against `upstage/solar-decide`, plus a write gate.

**Gate:**
- 100 test writes: **zero false rejections** (nothing valid is discarded)
- 100 test writes of noise: rejection rate measured and reported
- When the decision provider is forced to fail: **writes still succeed**, gate skipped, and the
  skip is recorded in the audit log

---

## Phase 6 — Rerank

**Deliverable:** rerank stage over the RRF-fused shortlist.

**Gate:**
- A labeled query set (30+ queries, hand-labeled relevant items) shows **measurable top-10
  improvement** over RRF alone. The number is recorded in the Phase 6 issue.
- With the decision provider down: results still return, in RRF order, flagged as unranked

---

## Phase 7 — Media and S3

**Deliverable:** MinIO integration, media ingest, multimodal embedding.

**Gate:**
- Upload an image, query it with text, get it back
- Upload a PDF, text extracted and indexed
- sha256 stored and verifiable; **ETag is never used as the integrity proof**

---

## Phase 8 — Cross-workspace retrieval

**Deliverable:** `_shared` database with entity edges, decision-gated traversal.

**Gate:**
- A query in workspace B returns an item from workspace A **only** when a real entity edge
  links them
- **Zero** results cross over when no edge exists
- Every cross-workspace result is labeled with its origin workspace
- With the decision provider down: **no cross-workspace results at all** (fail closed)

---

## Phase 9 — Migrate real memory

**Deliverable:** import the existing paradigm-memory data, re-embedding everything.

**Volume:** 42 items and 14 nodes in the main workspace; 125 items and 23 nodes in `geos-acervo`.

**Gate:**
- Item counts match exactly after import
- **Every embedding is a new vector** at the new dimension. Zero vectors carried over. This is
  explicit because the old vectors are 384-dimensional and semantically incompatible.
- Tree structure, node metadata, `importance`, `freshness`, `retrieval_policy`, and `supersedes`
  relationships survive intact
- Mutations audit log imported

**Rollback:** the original SQLite files are never modified. Migration reads from an exported
snapshot.

---

## Phase 10 — Public surface and cleanup

**Deliverable:** REST API, MCP server, removal of the local model runtime.

**Gate:**
- All 29 upstream MCP tools present and behaving
- `npm ls @huggingface/transformers` returns nothing; no ONNX, no local MiniLM, no local Qwen
- No script in the repo reinstalls a local model runtime
- New and old memory servers run side by side and return equivalent results for the same query

---

## Ordering rationale

Phases 1–3 are infrastructure with no external dependency, so they are where a broken design
gets caught cheaply. Phase 4 is the first thing that costs money, which makes it the natural
place to stop and verify the vector path before layering decisions on top. Phase 5's fallback
test is deliberately destructive: a memory system that fails to write when a decision model is
down is worse than one that writes unchecked.

Phases 8 and 9 are last because both are hard to reverse. Cross-workspace retrieval changes
what "isolated" means. Migration replaces live data.

---

## What "done" means for the whole project

- `docker compose up` on a clean machine, with one key in `.env`
- Search returns hybrid results with visible provenance
- No model runs locally, ever
- The old paradigm-memory installation is untouched and can be removed independently
