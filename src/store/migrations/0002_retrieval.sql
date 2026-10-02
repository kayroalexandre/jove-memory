-- ---------------------------------------------------------------------------
-- 0002 — Retrieval layers.
--
-- Four layers, four mechanisms, four different reasons a memory can be
-- relevant. Keeping them in separate tables is what lets a search report
-- which one contributed, rather than returning one opaque score that nobody
-- can debug (see docs/ARCHITECTURE.md, "the four PG layers").
--
-- Deliberately NOT in 0001: each phase should be testable on its own, and a
-- single 1-schema migration would mean every layer had to be right before
-- anything could be run.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Layer 1: vector.
--
-- The width is fixed at 3072 here, not read from config, because it is a
-- property of the column. `google/gemini-embedding-2` and a hypothetical
-- successor do not share a vector space, so changing the width means
-- re-embedding every memory (ADR-005). That is a migration with a data
-- migration, not a config edit — and pretending otherwise is how a
-- deployment ends up with two incompatible vectors in one index.
--
-- The runtime reads the real width out of information_schema and refuses to
-- query when it disagrees with config, so a mismatch is a startup error with
-- a clear message rather than a distance function that silently returns
-- garbage.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_item_vectors (
  item_id    TEXT        NOT NULL PRIMARY KEY,
  model      TEXT        NOT NULL,
  embedding  vector(3072) NOT NULL,

  -- Kept, and used to age the vector arm. A memory from two years ago
  -- embedding-space-close to the query is worth less than a fresh one, and
  -- cosine similarity cannot express that on its own.
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT memory_item_vectors_item_fk
    FOREIGN KEY (item_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

-- The index is the point of the layer. Without it this is a sequential scan
-- over a JSONB-shaped blob, and "vector search" would be a slower version of
-- ILIKE.
CREATE INDEX IF NOT EXISTS memory_item_vectors_model_idx
  ON memory_item_vectors(model);

-- ---------------------------------------------------------------------------
-- There is no ANN index here, and that is a measured constraint, not an
-- oversight.
--
-- docs/ARCHITECTURE.md specifies pgvector with HNSW. pgvector 0.8.6 refuses:
--
--   ERROR: column cannot have more than 2000 dimensions for hnsw index
--
-- `google/gemini-embedding-2` is 3072, and the width is not negotiable without
-- re-embedding every memory (ADR-005). So the vector arm runs as an exact
-- search: a sequential scan with a distance computation per row.
--
-- What that costs, stated plainly:
--
--   - Latency is linear in corpus size. Fine at a few thousand memories, which
--     is what a personal memory system holds. Not fine at a million.
--   - Every vector query reads the table. There is no way around it in 0.8.6.
--
-- What it does not cost: correctness. An exact search returns the true
-- nearest neighbours, so ranking quality is unaffected — this is a latency
-- problem, not an accuracy one, and the Phase 6 rerank benchmark measures
-- accuracy.
--
-- The escape hatch, when it is needed, is a narrower embedding. Gemini Embedding
-- 2 accepts 128–3072, and 1536 or 2048 would permit HNSW. That is a data
-- migration, not a config edit, and it is a decision to make when the corpus
-- actually needs it rather than in advance.
--
-- `memory_item_vectors_model_idx` above is a plain B-tree, which serves the
-- model filter and nothing else.

-- ---------------------------------------------------------------------------
-- Layer 2: BM25 / lexical.
--
-- A generated column, so the text is tokenised by the database on write and
-- can never drift from the content it describes. A maintained trigger or an
-- application-side write is the same idea with a failure mode: a missed
-- update leaves an item that text search cannot find.
--
-- `english` config is explicit. The default depends on the server's locale,
-- which means the same data ranks differently on two machines — and a search
-- that is not reproducible is a search that cannot be measured. Phase 6
-- measures ranking quality against this.
--
-- Tags reach the index as `tags::text`, the JSONB's own serialisation, rather
-- than a joined string. Two reasons: a generated column may not contain a
-- subquery, so the obvious `array_to_string(ARRAY(SELECT ...))` is not
-- available; and the serialisation is immutable, which a subquery-built
-- expression is not guaranteed to be. The tokens come out the same — the JSON
-- punctuation is not word material to the text parser.
--
-- If `pg_search` (ParadeDB) is ever installed, `capabilities()` reports
-- `bm25_engine: pg_search` and the query changes. It is never silent, which
-- is the property that matters — see issue #12.
-- ---------------------------------------------------------------------------

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(tags::text, '')), 'B')
    ) STORED;

CREATE INDEX IF NOT EXISTS memory_items_search_idx
  ON memory_items USING GIN(search_vector);

-- ---------------------------------------------------------------------------
-- Layer 3: graph.
--
-- Edges between items. Not a foreign key: an edge is a claim about
-- relationship ("mentions", "contradicts", "same_entity_as"), and the claim
-- outlives either endpoint's lifetime. A cascade here would silently delete
-- edges pointing at a memory somebody deleted, which loses the information
-- that a contradiction ever existed.
--
-- `entity_edges` is the name the capabilities report uses, and it is the
-- cross-workspace table too: in `_shared` the same table holds edges between
-- entities in different workspaces, which is how recall crosses a boundary
-- without merging the contexts. That is the whole mechanism, and it is
-- Phase 8's job. The schema is here now because the columns are the same.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_edges (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Free-form, not a foreign key, and deliberately allowed to dangle.
  from_item  TEXT        NOT NULL,
  to_item    TEXT        NOT NULL,

  -- Same entity, mentions, contradicts, supersedes, co_occurs. The set is
  -- open; the graph layer must not have to be redeployed to learn a new one.
  relation   TEXT        NOT NULL,

  -- 0..1 confidence in the edge itself, kept separate from the endpoints'
  -- confidence. A strong memory can have a weak link to another.
  weight     REAL        NOT NULL DEFAULT 1.0
                CHECK (weight >= 0 AND weight <= 1),

  -- Where the edge came from. An edge the decision model proposed and one a
  -- human confirmed are different evidence, and calibration needs to tell
  -- them apart.
  source     TEXT        NOT NULL DEFAULT 'system',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Traversal goes out from one item, so the leading column is from_item. The
-- reverse direction gets its own index rather than an OR condition, because
-- an OR across two btrees uses neither.
CREATE INDEX IF NOT EXISTS entity_edges_from_idx  ON entity_edges(from_item, relation);
CREATE INDEX IF NOT EXISTS entity_edges_to_idx    ON entity_edges(to_item, relation);
CREATE INDEX IF NOT EXISTS entity_edges_rel_idx   ON entity_edges(relation, weight DESC);

-- Self-edges are always a bug: they add a hop that reaches nowhere.
CREATE INDEX IF NOT EXISTS entity_edges_no_self_loop
  ON entity_edges(from_item) WHERE from_item = to_item;

-- ---------------------------------------------------------------------------
-- Layer 4: temporal.
--
-- No new table. `memory_items` already carries the bitemporal columns from
-- 0001 (recorded_at, occurred_start, occurred_end, invalidated_at), and the
-- temporal arm of retrieval is a *function* of those plus the query time, not
-- a separate index.
--
-- What it needs is an index that answers "current and relevant" cheaply. The
-- partial index below covers exactly the rows the arm is allowed to consider:
-- valid, not deleted, and still true.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS memory_items_current_idx
  ON memory_items(occurred_start DESC NULLS LAST, importance DESC)
  WHERE invalidated_at IS NULL AND deleted_at IS NULL AND status = 'active';

-- ---------------------------------------------------------------------------
-- Search accounting.
--
-- One row per executed search. The Phase 3 gate is that a `debug` block shows
-- all four layers' contributions with real values; persisting the run is what
-- makes that checkable after the fact, and it is the substrate Phase 6 needs
-- to measure rerank against an unranked baseline.
--
-- Append-only, no id, no update path.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS search_runs (
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_hash TEXT        NOT NULL,
  workspace  TEXT        NOT NULL,

  -- Counts per arm, and NULL where an arm produced nothing. A zero and a
  -- NULL mean different things: zero is "this arm ran and matched nothing",
  -- NULL is "this arm did not run". The gate is about telling them apart.
  vector_hits  INTEGER,
  bm25_hits    INTEGER,
  graph_hits   INTEGER,
  temporal_hits INTEGER,

  -- The per-arm weighting actually applied, so a re-run of the same query
  -- months later reproduces the ranking.
  weights JSONB NOT NULL DEFAULT '{}'::jsonb,

  rrf_k      REAL,
  results    INTEGER,
  took_ms    INTEGER,

  bm25_engine TEXT,
  embed_model TEXT
);

CREATE INDEX IF NOT EXISTS search_runs_at_idx ON search_runs(ran_at DESC);
CREATE INDEX IF NOT EXISTS search_runs_query_idx ON search_runs(query_hash, ran_at DESC);
