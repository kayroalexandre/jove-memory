-- jove-memory workspace schema, version 1.
--
-- This file is the authoritative schema for a workspace database. It is applied
-- by src/store/migrate.mjs and its version is recorded in schema_meta.
--
-- Phase 1 scope: relational + bitemporal. The vector column, the BM25 index and
-- the entity_edges table are added in Phase 3, as migrations 0002 and 0003.
-- Adding them here instead would make Phase 3 untestable in isolation, which
-- is the failure mode the phase ordering exists to prevent.

CREATE TABLE IF NOT EXISTS schema_meta (
  version         INTEGER     PRIMARY KEY,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding_model TEXT,
  embed_dimensions INTEGER
);

-- ---------------------------------------------------------------------------
-- Nodes: the tree. Preserved from the upstream model (ADR-001), because the
-- cognitive-map activation in atlas.mjs depends on it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_nodes (
  id                TEXT PRIMARY KEY,
  parent_id         TEXT        REFERENCES memory_nodes(id) ON DELETE SET NULL,
  label             TEXT        NOT NULL,
  summary           TEXT,
  one_liner         TEXT,
  node_type         TEXT,
  status            TEXT,

  -- Activation scoring reads these. Kept as the upstream named them so the
  -- scoring code ports across without renaming.
  importance        REAL        NOT NULL DEFAULT 0.5,
  activation        REAL        NOT NULL DEFAULT 0.0,
  confidence        REAL        NOT NULL DEFAULT 0.8,
  freshness         REAL        NOT NULL DEFAULT 0.5,

  last_touched      TIMESTAMPTZ,
  retrieval_policy  JSONB,
  keywords          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  children          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  links             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sources           JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_nodes_parent_idx   ON memory_nodes(parent_id);
CREATE INDEX IF NOT EXISTS memory_nodes_status_idx   ON memory_nodes(status);
-- Activation ranking reads these two together on every search.
CREATE INDEX IF NOT EXISTS memory_nodes_score_idx    ON memory_nodes(activation DESC, importance DESC);

-- ---------------------------------------------------------------------------
-- Items: the memories. JSONB rather than TEXT for tags, because tag filtering
-- is a query, not a substring match. A TEXT column would force every filtered
-- search to load and parse every row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_items (
  -- No default. The application generates ids, because it needs the workspace
  -- in them and because upstream ids have a documented shape. A default here
  -- would silently accept an insert that forgot to set one.
  id             TEXT PRIMARY KEY,

  -- Deliberately not a foreign key with ON DELETE CASCADE. Deleting a node
  -- must not delete its items; it orphans them, and the doctor reports orphans
  -- for review. Losing memories because someone tidied the tree is not
  -- recoverable.
  node_id        TEXT        NOT NULL,

  content        TEXT        NOT NULL,
  tags           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source         TEXT,

  importance     REAL        NOT NULL DEFAULT 0.5,
  confidence     REAL        NOT NULL DEFAULT 0.8,

  status         TEXT        NOT NULL DEFAULT 'active',
  deleted_at     TIMESTAMPTZ,
  supersedes     TEXT,

  -- Bitemporal. `created_at`/`updated_at` are bookkeeping; these three are the
  -- memory's own timeline and answer questions the bookkeeping cannot.
  --   recorded_at     — when the system learned this
  --   occurred_start   — when it became true in the world
  --   occurred_end     — when it stopped being true (NULL while still true)
  --   invalidated_at   — when the system learned it stopped being true
  --
  -- An invalidated fact is retained, not deleted. "What did I believe about X
  -- in March" is only answerable because nothing is thrown away.
  occurred_start TIMESTAMPTZ,
  occurred_end   TIMESTAMPTZ,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_items_node_idx      ON memory_items(node_id);
CREATE INDEX IF NOT EXISTS memory_items_status_idx    ON memory_items(status);
CREATE INDEX IF NOT EXISTS memory_items_recorded_idx  ON memory_items(recorded_at DESC);
-- The temporal arm of retrieval filters on validity, so this is a hot path.
CREATE INDEX IF NOT EXISTS memory_items_temporal_idx
  ON memory_items(occurred_start, occurred_end)
  WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_items_tags_idx      ON memory_items USING GIN(tags);

-- ---------------------------------------------------------------------------
-- Mutations: the append-only audit log.
--
-- Append-only by convention, enforced by a trigger. This log is what proves
-- what happened to the user's memory, so an UPDATE or DELETE here is a bug
-- severe enough to be worth making impossible rather than unlikely.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_mutations (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  operation TEXT        NOT NULL,
  item_id   TEXT,
  node_id   TEXT,
  reason    TEXT,
  actor     TEXT,
  payload   JSONB
);

CREATE INDEX IF NOT EXISTS memory_mutations_at_idx    ON memory_mutations(at DESC);
CREATE INDEX IF NOT EXISTS memory_mutations_item_idx  ON memory_mutations(item_id);
CREATE INDEX IF NOT EXISTS memory_mutations_node_idx  ON memory_mutations(node_id);

CREATE OR REPLACE FUNCTION memory_mutations_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'memory_mutations is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_mutations_no_update ON memory_mutations;
CREATE TRIGGER memory_mutations_no_update
  BEFORE UPDATE OR DELETE ON memory_mutations
  FOR EACH ROW EXECUTE FUNCTION memory_mutations_append_only();

-- ---------------------------------------------------------------------------
-- Embeddings.
--
-- Phase 1 stored vectors as JSONB so that it stayed free of a dependency on
-- the dimension decision, and each phase was testable on its own.
--
-- What Phase 3 actually did, rather than what this comment originally claimed:
-- it did NOT migrate this table. It added a separate `memory_item_vectors`
-- with a real `vector(3072)` column and left this one alone. Two tables, two
-- jobs:
--
--   memory_item_vectors — per-item search vectors, in a column, queryable
--                         with a distance operator.
--   memory_embeddings   — this one. A content-addressed cache keyed by text
--                         hash, for anything embedded that is not an owned
--                         item: a query, a node summary, a rerank candidate.
--                         No item, no node, no cascade.
--
-- JSONB here is therefore not temporary. A query vector has no item row to
-- hang off, and this is where it lives.
--
-- The primary key is (cache_key, model), carried over from upstream: two models
-- can hold different vectors for the same text, and neither can overwrite the
-- other. That property is what makes a model migration safe.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_embeddings (
  cache_key  TEXT        NOT NULL,
  model      TEXT        NOT NULL,
  text_hash  TEXT        NOT NULL,
  vector     JSONB       NOT NULL,
  dimensions INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cache_key, model)
);

CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model);

-- ---------------------------------------------------------------------------
-- Decision log.
--
-- Every decision-model call is recorded, not only the ones that changed
-- behaviour. Calibration needs the negative cases: a threshold can only be
-- measured against what the system decided NOT to do. See docs/THRESHOLDS.md.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS decisions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  operation      TEXT        NOT NULL,

  -- The model that answered, pinned by exact id. An alias would make a
  -- calibration number impossible to reproduce later.
  model          TEXT        NOT NULL,
  question_key   TEXT,
  question_type  TEXT,

  noul_score     REAL,
  choice         TEXT,
  score          REAL,
  confidence     REAL,

  was_applied    BOOLEAN     NOT NULL DEFAULT FALSE,
  threshold_used REAL,

  -- Set later by feedback, a user revert, or a consolidation outcome. This is
  -- the label calibration trains against.
  outcome        TEXT,

  context_hash   TEXT,
  latency_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS decisions_operation_idx ON decisions(operation, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_unlabelled_idx ON decisions(operation) WHERE outcome IS NULL;

-- ---------------------------------------------------------------------------
-- Feedback, separate from decisions.
--
-- Kept apart so a user correction is never mistaken for a model observation,
-- and so retracting feedback is possible.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_feedback (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  item_id    TEXT        NOT NULL,
  signal     TEXT        NOT NULL CHECK (signal IN ('useful', 'ignored')),
  reason     TEXT,
  actor      TEXT
);

CREATE INDEX IF NOT EXISTS memory_feedback_item_idx ON memory_feedback(item_id);
