-- ---------------------------------------------------------------------------
-- 0005 — Cross-workspace entity edges.
--
-- Edges between entities in *different* workspaces, and they live only in
-- `_shared`.
--
-- The requirement this table exists to satisfy: **recall across workspaces
-- without mixing contexts.** An item in workspace A is retrievable from a query
-- in workspace B only when something in B is linked to it by a recorded edge,
-- and even then only when the decision model says the link is relevant to this
-- particular query. Nothing is ever returned because it was "nearby".
--
-- ## Why a separate table rather than widening `entity_edges`
--
-- `entity_edges` is a per-workspace table and its endpoints are items in that
-- workspace. A cross-workspace edge has endpoints in two different databases,
-- so it cannot live in either. Putting it in `_shared` is what makes it
-- neutral: no workspace owns the edge, and deleting either workspace does not
-- silently change the other's view of it.
--
-- It also means the *existence* of a cross-workspace link is itself a fact
-- about the shared layer, and a workspace cannot discover another's edges by
-- accident. Reading `entity_edges` in your own database cannot leak anything.
--
-- ## Fail closed
--
-- The asymmetry that governs this phase: ordinary retrieval degrades **open**
-- (a provider outage means three layers instead of four), and cross-workspace
-- retrieval degrades **closed** (a provider outage means *nothing* crosses).
--
-- The two are not symmetric. Returning slightly worse results is a quality
-- problem. Returning another workspace's content because a safety check could
-- not run is a context leak, and this system holds personal memory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cross_workspace_edges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both endpoints, named by workspace. The order is not meaningful: an edge
  -- from A to B is the same edge as one from B to A, and `UNIQUE` below is on
  -- the sorted pair so the same link cannot be recorded in both directions.
  workspace_from TEXT       NOT NULL,
  item_from      TEXT       NOT NULL,
  workspace_to   TEXT       NOT NULL,
  item_to        TEXT       NOT NULL,

  -- Why these two are the same thing. `same_entity` is a claim about identity
  -- (the person named in both memories); `contradicts` is a claim about
  -- conflict, which is the one edge that makes a *correction* reachable from
  -- the other workspace and is deliberately a separate relation rather than a
  -- flag.
  relation       TEXT       NOT NULL,
  -- What the link is based on: the shared entity's name, a shared identifier.
  -- Stored because "these are the same because their name matched" and "these
  -- are the same because a human said so" are different strengths of evidence,
  -- and calibration needs to tell them apart.
  basis          TEXT       NOT NULL DEFAULT 'entity',

  -- Confidence in the *edge*, separate from the confidence in either endpoint.
  -- A strongly-held memory can be weakly linked to another.
  confidence     REAL        NOT NULL DEFAULT 1.0
                   CHECK (confidence >= 0 AND confidence <= 1),

  -- A confirmed link is one a human agreed with. A machine-proposed link that
  -- nobody has looked at is not treated the same, and the distinction is the
  -- point of the column rather than a boolean in the relation.
  confirmed      BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Self-edge across the same item is a bug: a link from something to itself
  -- is a hop that reaches nowhere and looks like evidence.
  CONSTRAINT cross_workspace_not_self CHECK (item_from <> item_to),
  CONSTRAINT cross_workspace_distinct_workspaces CHECK (workspace_from <> workspace_to),
  CONSTRAINT cross_workspace_pair_unique
    UNIQUE (workspace_from, item_from, workspace_to, item_to, relation)
);

-- Lookup is always "edges touching this item in this workspace", in both
-- directions, so both endpoint columns are indexed.
CREATE INDEX IF NOT EXISTS cross_workspace_from_idx
  ON cross_workspace_edges(workspace_from, item_from, confidence DESC);
CREATE INDEX IF NOT EXISTS cross_workspace_to_idx
  ON cross_workspace_edges(workspace_to, item_to, confidence DESC);

-- "Which other workspaces is this one linked to at all", which is the question
-- a cross-workspace audit asks and which no other index answers.
CREATE INDEX IF NOT EXISTS cross_workspace_workspaces_idx
  ON cross_workspace_edges(workspace_from, workspace_to);

-- ---------------------------------------------------------------------------
-- Traversal audit
--
-- Every cross-workspace expansion, whether or not it returned anything. A gate
-- that only records what it let through cannot be reviewed: the interesting
-- case is the link that existed and was refused, because that is either the
-- threshold working or a bug, and they look identical from the outside.
--
-- Append-only, like the other three audit tables in this schema.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cross_workspace_audit (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Which query caused the expansion. The query text is deliberately absent:
  -- this is the table that would otherwise hold a copy of every question asked
  -- across every workspace boundary.
  query_hash   TEXT        NOT NULL,
  from_workspace TEXT      NOT NULL,

  edges_found   INTEGER     NOT NULL DEFAULT 0,
  candidates    INTEGER     NOT NULL DEFAULT 0,
  admitted      INTEGER     NOT NULL DEFAULT 0,
  threshold_used REAL,

  -- 'ok' | 'no_edges' | 'below_threshold' | 'provider_unavailable' |
  -- 'no_provider' | 'error'
  outcome       TEXT        NOT NULL,
  -- The reason, in words. A status code is not a diagnosis.
  detail        TEXT
);

CREATE OR REPLACE FUNCTION cross_workspace_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'cross_workspace_audit is append-only. A record of which contexts were '
    'consulted that can be edited afterwards is not a record.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cross_workspace_audit_no_update ON cross_workspace_audit;
CREATE TRIGGER cross_workspace_audit_no_update
  BEFORE UPDATE OR DELETE ON cross_workspace_audit
  FOR EACH ROW EXECUTE FUNCTION cross_workspace_audit_append_only();

CREATE INDEX IF NOT EXISTS cross_workspace_audit_at_idx
  ON cross_workspace_audit(at DESC);
CREATE INDEX IF NOT EXISTS cross_workspace_audit_from_idx
  ON cross_workspace_audit(from_workspace, at DESC);
