# Architecture decision records

Each entry records a decision that was made, and what it costs. Entries are immutable once
accepted; a change of mind is a new entry that supersedes an old one.

---

## ADR-001: Fork paradigm-memory instead of starting fresh

**Status:** accepted

**Context:** A memory system already exists, works, is Apache-2.0, and has a 29-tool MCP
surface that clients depend on.

**Decision:** Fork it. Preserve the MCP surface. Replace the storage substrate and the model
layer.

**Consequences:**
- The MCP contract is inherited, so existing clients keep working
- The upstream architecture is inherited too, including the parts we are replacing
- **The fork diverges permanently.** Upstream releases cannot be merged without resolving
  conflicts in the store and model layer by hand. This is accepted deliberately: those layers
  are being replaced wholesale, so there is nothing to merge.

---

## ADR-002: PostgreSQL 18 with pgvector, not a dedicated vector database

**Status:** accepted

**Context:** The system needs semantic search, keyword search, relationship traversal, and
temporal queries.

**Decision:** One PostgreSQL, four access layers (pgvector, pg_search, entity edges with
recursive CTE, bitemporal columns).

**Consequences:**
- One database to back up, one to secure, one transaction spanning all layers
- Hybrid retrieval is a single query, not a fan-out across services
- Extension availability becomes a deployment concern (see the fallback in ARCHITECTURE.md)

**Rejected:** Qdrant (no relational layer, no BM25), Neo4j (weak vector support), running four
databases (four backup paths, four failure modes, cross-database consistency on every write).

---

## ADR-003: One database per workspace, not one schema

**Status:** accepted

**Context:** Workspaces need isolation. Schemas in a shared database are the cheap option.

**Decision:** One database per workspace.

**Consequences:**
- True isolation: separate connection pools, separate memory budgets, no `search_path` mistakes
- Cross-workspace queries are impossible by accident
- Requires a `_shared` database plus explicit edges for any cross-workspace retrieval, which
  makes those retrievals deliberate rather than incidental

---

## ADR-004: Cross-workspace retrieval only through shared entity edges

**Status:** accepted

**Context:** Isolation that forgets everything in other workspaces is amnesia, not isolation.
But unrestricted cross-workspace search mixes contexts.

**Decision:** Cross-workspace retrieval requires (a) an entity edge in `_shared` linking the
two, and (b) a decision model score above the cross-workspace threshold. Fails closed.

**Consequences:**
- The system knows what exists elsewhere because it knows the entities are related
- No scanning, no accidental bleed
- Requires entity linking to be built and maintained, which is real work

---

## ADR-005: google/gemini-embedding-2 as the single embedding space

**Status:** accepted

**Context:** Options were a text-only model, or a model that places text and images in one
space.

**Decision:** `google/gemini-embedding-2`, single space, single index. 3072 dimensions.

**Consequences:**
- Text queries retrieve images and image queries retrieve text, from one index
- No query classifier needed to pick between indexes
- No dual index to maintain or migrate
- **The choice is not reversible at runtime.** Different models do not share a vector space.
  Changing it means re-embedding everything.

---

## ADR-006: qwen/qwen3.8-flash for inference

**Status:** accepted

**Context:** Needs to be current, cheap, and multimodal.

**Decision:** `qwen/qwen3.8-flash` — $0.15/M in, $0.47/M out, 1M context, multimodal,
released 2026-08-26.

**Consequences:**
- Roughly 2× cheaper than Gemini 3.5 Flash Lite, 5× cheaper on input than Gemini 3.7 Flash
- Multimodal means media in memory can be described without a separate vision call
- 39 tokens/sec throughput on the single provider is the latency ceiling

**Fallback:** `deepseek/deepseek-v4-flash`.

---

## ADR-007: upstage/solar-decide for decisions and reranking

**Status:** accepted

**Context:** Reranking and gating need calibrated probabilities. Options were
`typesafe/jev-1.13` (32k context) and `upstage/solar-decide` (524k context).

**Decision:** `upstage/solar-decide`. $0.05/M in, $0/M out. Same System One schema, so
swapping back to Jev is a config change.

**Consequences:**
- 524k of context means a shortlist can be reranked in **one** request instead of one request
  per candidate pair. This is the single biggest latency win in the design.
- Output is free, so adding questions to a request is nearly free
- **It is a beta model.** Pinned by exact id, treated as replaceable, and every call site has
  a fallback

**Rejected:** `typesafe/jev-1.13` — 32k context makes per-pair reranking the only option, which
is N round-trips instead of one.

---

## ADR-008: Decision model failures degrade, never block

**Status:** accepted

**Context:** Six decisions depend on a beta external model.

**Decision:** Every decision call has a fallback. Retrieval without rerank, writes without a
gate, cross-workspace retrieval fails closed. Degradation is always reported in the response.

**Consequences:**
- A decision-model outage degrades quality, never availability
- Cross-workspace retrieval is the one path that fails **closed** rather than open, because
  leaking context is worse than missing it
- Responses carry a `debug.degraded` array, so a caller always knows what it is not getting

---

## ADR-009: No local model fallback

**Status:** accepted

**Context:** Cloud providers fail. A local fallback is the usual answer.

**Decision:** No local models. When the cloud path fails, retrieval degrades to BM25.

**Consequences:**
- No ONNX Runtime, no model weights, no Transformers.js in the image. Roughly 1.2 GB of
  attack surface and disk removed as a side effect.
- **Semantic search is genuinely unavailable during a provider outage.** BM25 still works.
- A second runtime would need its own tests, its own failure modes, and its own version pinning

**Rejected:** bundling a small local embedder "just in case". It would be untested in practice
and untested in CI, which is worse than a clean, visible degradation.

---

## ADR-010: Thresholds are calibrated, never hand-guessed

**Status:** accepted

**Context:** Six decisions need a threshold. Picking 0.6 by hand is a guess.

**Decision:** Thresholds start at configured defaults, are measured against labeled data, and
are adjusted via pull request. Never applied automatically at runtime.

**Consequences:**
- The system improves without the owner needing to know how to calibrate
- The owner is notified only when something needs review, and silence means stable
- `cross_workspace` can only be loosened by a human, never automatically

See [THRESHOLDS.md](THRESHOLDS.md).

---

## ADR-011: Media bytes in S3, never in the database

**Status:** accepted

**Context:** Memory will hold images, PDFs, and eventually other media.

**Decision:** Bytes go to S3-compatible storage. Postgres holds pointer, sha256, MIME type, and
extracted text.

**Consequences:**
- Database stays small and fast to back up
- Media can be large without degrading search
- Two things to back up instead of one
- S3 ETag is never trusted as integrity proof, because multipart uploads produce ETags that are
  not content hashes

---

## ADR-012: Modules split by dependency, not by feature

**Status:** accepted

**Context:** Upstream's `memory-service.mjs` is 1408 lines mixing storage, retrieval,
consolidation, and transport. Adding features to it produces a file nobody can debug.

**Decision:** Seven modules, split along dependency lines. `store/` is the only thing that
touches SQL. Implementation order follows the dependency graph.

**Consequences:**
- Each module is testable without the others running
- Each phase in PLAN.md delivers a working, gated increment
- More files, more import boundaries to maintain
