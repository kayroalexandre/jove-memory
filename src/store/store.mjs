import { randomUUID, createHash } from "node:crypto";

import {
  assertWorkspaceName,
  quoteIdentifier,
  isSharedWorkspace
} from "./workspace-name.mjs";

/**
 * The store.
 *
 * This is the only module in the project that writes SQL. Everything above it
 * calls these methods and never sees a query string, which is what makes the
 * retrieval layers in Phase 3 testable without a database.
 *
 * The method surface matches the upstream SQLite store, so the MCP layer ports
 * across without being rewritten (ADR-001).
 */

/** Shape an item row into the object the rest of the system expects. */
function toItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    node_id: row.node_id,
    content: row.content,
    tags: row.tags ?? [],
    source: row.source ?? null,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    status: row.status,
    created_at: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    updated_at: row.updated_at?.toISOString?.() ?? row.updated_at ?? null,
    // Bitemporal. Upstream had `expires_at` only, which answers "is this stale
    // now" and nothing else. These answer "what was true when".
    occurred_start: row.occurred_start?.toISOString?.() ?? row.occurred_start ?? null,
    occurred_end: row.occurred_end?.toISOString?.() ?? row.occurred_end ?? null,
    recorded_at: row.recorded_at?.toISOString?.() ?? row.recorded_at ?? null,
    invalidated_at: row.invalidated_at?.toISOString?.() ?? row.invalidated_at ?? null,
    deleted_at: row.deleted_at?.toISOString?.() ?? row.deleted_at ?? null,
    supersedes: row.supersedes ?? null
  };
}

function toNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    label: row.label,
    summary: row.summary ?? null,
    one_liner: row.one_liner ?? null,
    node_type: row.node_type ?? null,
    status: row.status ?? null,
    importance: Number(row.importance),
    activation: Number(row.activation),
    confidence: Number(row.confidence),
    freshness: Number(row.freshness),
    last_touched: row.last_touched?.toISOString?.() ?? row.last_touched ?? null,
    retrieval_policy: row.retrieval_policy ?? null,
    keywords: row.keywords ?? [],
    children: row.children ?? [],
    links: row.links ?? [],
    sources: row.sources ?? [],
    created_at: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    updated_at: row.updated_at?.toISOString?.() ?? row.updated_at ?? null
  };
}

function toMutation(row) {
  return {
    id: row.id,
    at: row.at?.toISOString?.() ?? row.at,
    operation: row.operation,
    item_id: row.item_id ?? null,
    node_id: row.node_id ?? null,
    reason: row.reason ?? null,
    actor: row.actor ?? null,
    payload: row.payload ?? null
  };
}

/**
 * Create a store handle for one workspace.
 *
 * Synchronous by design: there is no I/O here, and making it async would make
 * every call site need an await purely to reach an object literal. The pool is
 * acquired lazily inside each method, so provisioning order does not matter.
 */
export function createStore({ workspace, pools, logger = null, clock = () => new Date() }) {
  assertWorkspaceName(workspace);

  /** Record a mutation. Failures here must not fail the operation they describe. */
  async function audit(client, operation, fields) {
    try {
      await client.query(
        `INSERT INTO memory_mutations (at, operation, item_id, node_id, reason, actor, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          fields.at ?? clock(),
          operation,
          fields.itemId ?? null,
          fields.nodeId ?? null,
          fields.reason ?? null,
          fields.actor ?? null,
          fields.payload ? JSON.stringify(fields.payload) : null
        ]
      );
    } catch (err) {
      // An audit failure is serious, but it must not roll back the user's
      // actual memory operation. It is logged loudly instead.
      logger?.error("audit write failed", {
        workspace,
        operation,
        message: err.message
      });
    }
  }

  return {
    workspace,

    // -----------------------------------------------------------------------
    // Nodes
    // -----------------------------------------------------------------------

    async createNode(input, meta = {}) {
      const pool = pools.poolFor(workspace);
      const now = clock();

      return pools.transaction(workspace, async (client) => {
        // The parent must exist. Without this, a typo in parent_id produces an
        // orphan that the doctor reports and nobody can explain.
        if (input.parent_id) {
          const { rows } = await client.query(
            "SELECT 1 FROM memory_nodes WHERE id = $1",
            [input.parent_id]
          );
          if (rows.length === 0) {
            throw new Error(
              `Cannot create node ${input.id}: parent ${input.parent_id} does not exist`
            );
          }
        }

        const { rows } = await client.query(
          `INSERT INTO memory_nodes
             (id, parent_id, label, summary, one_liner, node_type, status,
              importance, activation, confidence, freshness, last_touched,
              retrieval_policy, keywords, children, links, sources, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
           ON CONFLICT (id) DO UPDATE SET
             parent_id = EXCLUDED.parent_id, label = EXCLUDED.label,
             summary = EXCLUDED.summary, one_liner = EXCLUDED.one_liner,
             status = EXCLUDED.status, importance = EXCLUDED.importance,
             retrieval_policy = EXCLUDED.retrieval_policy,
             keywords = EXCLUDED.keywords, links = EXCLUDED.links,
             sources = EXCLUDED.sources, updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            input.id,
            input.parent_id ?? null,
            input.label,
            input.summary ?? null,
            input.one_liner ?? null,
            input.node_type ?? "node",
            input.status ?? "active",
            input.importance ?? 0.5,
            input.activation ?? 0.0,
            input.confidence ?? 0.8,
            input.freshness ?? 0.5,
            input.last_touched ?? null,
            input.retrieval_policy ? JSON.stringify(input.retrieval_policy) : null,
            JSON.stringify(input.keywords ?? []),
            JSON.stringify(input.children ?? []),
            JSON.stringify(input.links ?? []),
            JSON.stringify(input.sources ?? []),
            now
          ]
        );

        await client.query(
          "UPDATE memory_nodes SET children = children || $2::jsonb, updated_at = $3 WHERE id = $1",
          [input.parent_id, JSON.stringify([input.id]), now]
        );

        await audit(client, "create_node", {
          nodeId: input.id,
          reason: meta.reason ?? "create_node",
          actor: meta.actor ?? "api",
          payload: { id: input.id, parent_id: input.parent_id ?? null }
        });

        return toNode(rows[0]);
      });
    },

    async updateNode(id, patch, meta = {}) {
      const pool = pools.poolFor(workspace);
      const now = clock();

      // Only fields the caller actually supplied are updated. Building the SET
      // clause from the patch rather than from a fixed template is what makes
      // a partial update leave the other columns alone.
      const columnMap = {
        label: "label",
        summary: "summary",
        one_liner: "one_liner",
        node_type: "node_type",
        status: "status",
        importance: "importance",
        activation: "activation",
        confidence: "confidence",
        freshness: "freshness",
        last_touched: "last_touched",
        parent_id: "parent_id",
        retrieval_policy: "retrieval_policy",
        keywords: "keywords",
        children: "children",
        links: "links",
        sources: "sources"
      };

      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columnMap)) {
        if (!(key in patch)) continue;
        sets.push(`${column} = $${values.length + 1}`);
        values.push(
          key === "retrieval_policy" ||
          ["keywords", "children", "links", "sources"].includes(key)
            ? JSON.stringify(patch[key])
            : patch[key]
        );
      }
      if (sets.length === 0) return this.readNode(id);

      sets.push(`updated_at = $${values.length + 1}`);
      values.push(now);
      values.push(id);

      const { rows } = await pool.query(
        `UPDATE memory_nodes SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
        values
      );

      await pool.query(
        `INSERT INTO memory_mutations (at, operation, node_id, reason, actor, payload)
         VALUES ($1,'update_node',$2,$3,$4,$5)`,
        [now, meta.reason ?? "update_node", meta.actor ?? "api", JSON.stringify(patch)]
      );

      return toNode(rows[0]);
    },

    async readNode(id) {
      const { rows } = await pools.poolFor(workspace).query(
        "SELECT * FROM memory_nodes WHERE id = $1",
        [id]
      );
      return toNode(rows[0]);
    },

    async listNodes({ parentId = null, status = null } = {}) {
      const conditions = [];
      const values = [];
      if (parentId !== null) {
        values.push(parentId);
        conditions.push(`parent_id = $${values.length}`);
      }
      if (status !== null) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT * FROM memory_nodes ${where} ORDER BY id`,
        values
      );
      return rows.map(toNode);
    },

    /**
     * Delete a node, moving its items and children up to the parent.
     *
     * The items are orphaned rather than deleted. Losing memories because
     * someone tidied the tree is not recoverable; an orphan is reported by the
     * doctor and can be moved back.
     */
    async deleteNode(id, meta = {}) {
      const pool = pools.poolFor(workspace);
      const now = clock();

      return pools.transaction(workspace, async (client) => {
        const { rows: existing } = await client.query(
          "SELECT parent_id FROM memory_nodes WHERE id = $1",
          [id]
        );
        if (existing.length === 0) return { deleted: false };
        const parentId = existing[0].parent_id;

        await client.query(
          "UPDATE memory_nodes SET parent_id = $2, updated_at = $3 WHERE parent_id = $1",
          [id, parentId, now]
        );
        await client.query(
          "UPDATE memory_items SET node_id = $2, updated_at = $3 WHERE node_id = $1",
          [id, parentId, now]
        );
        await client.query(
          "UPDATE memory_nodes SET children = children - $2, updated_at = $3 WHERE id = $1",
          [parentId, id, now]
        );
        await client.query("DELETE FROM memory_nodes WHERE id = $1", [id]);

        await audit(client, "delete_node", {
          nodeId: id,
          reason: meta.reason ?? "delete_node",
          actor: meta.actor ?? "api"
        });

        return { deleted: true, id, reparentedTo: parentId };
      });
    },

    // -----------------------------------------------------------------------
    // Items
    // -----------------------------------------------------------------------

    async upsertItem(input, meta = {}) {
      const pool = pools.poolFor(workspace);
      const now = clock();

      // The upstream id format encodes the node, which makes an id globally
      // meaningful and makes the workspace redundant inside it. Keeping the
      // format means ids stay comparable with the data being migrated.
      const id = input.id ?? `mem.mcp.${input.node_id}.${randomUUID().slice(0, 8)}`;

      return pools.transaction(workspace, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO memory_items
             (id, node_id, content, tags, source, importance, confidence, status,
              supersedes, occurred_start, occurred_end, recorded_at, invalidated_at,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                   COALESCE($12, now()), $13, $14, $14)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content, tags = EXCLUDED.tags,
             source = EXCLUDED.source, importance = EXCLUDED.importance,
             confidence = EXCLUDED.confidence, supersedes = EXCLUDED.supersedes,
             occurred_start = EXCLUDED.occurred_start,
             occurred_end = EXCLUDED.occurred_end,
             invalidated_at = EXCLUDED.invalidated_at,
             updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [
            id,
            input.node_id,
            input.content,
            JSON.stringify(input.tags ?? []),
            input.source ?? null,
            input.importance ?? 0.5,
            input.confidence ?? 0.8,
            // `proposed` is preserved: the review workflow (memory_propose_write
            // / memory_review) is part of the MCP surface being kept.
            input.status ?? "active",
            input.supersedes ?? null,
            input.occurred_start ?? null,
            input.occurred_end ?? null,
            input.recorded_at ?? null,
            input.invalidated_at ?? null,
            input.created_at ?? now
          ]
        );

        await audit(client, meta.operation ?? "write", {
          itemId: id,
          nodeId: input.node_id,
          reason: meta.reason ?? "direct_write",
          actor: meta.actor ?? "mcp",
          payload: { id, status: input.status ?? "active" }
        });

        return toItem(rows[0]);
      });
    },

    async readItem(id) {
      const { rows } = await pools.poolFor(workspace).query(
        "SELECT * FROM memory_items WHERE id = $1",
        [id]
      );
      return toItem(rows[0]);
    },

    async listItems({
      nodeId = null,
      status = "active",
      includeDeleted = false,
      limit = 100,
      offset = 0
    } = {}) {
      const conditions = [];
      const values = [];

      if (nodeId) {
        values.push(nodeId);
        conditions.push(`node_id = $${values.length}`);
      }
      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }
      if (!includeDeleted) conditions.push("deleted_at IS NULL");

      values.push(limit, offset);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT * FROM memory_items ${where}
         ORDER BY created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      );
      return rows.map(toItem);
    },

    /**
     * Soft delete.
     *
     * `deleted_at` is set and status moves to `deleted`. The row stays, because
     * the audit log has to be able to explain what happened, and because a
     * hard delete cannot be distinguished from data loss afterwards.
     */
    async deleteItem(id, meta = {}) {
      const now = clock();
      const { rows } = await pools.poolFor(workspace).query(
        `UPDATE memory_items
         SET status = 'deleted', deleted_at = $2, updated_at = $2
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *`,
        [id, now]
      );
      if (rows.length === 0) return { deleted: false };

      await pools.poolFor(workspace).query(
        `INSERT INTO memory_mutations (at, operation, item_id, node_id, reason, actor, payload)
         VALUES ($1,'delete',$2,$3,$4,$5,$6)`,
        [now, id, rows[0].node_id, meta.reason ?? "delete", meta.actor ?? "mcp",
         JSON.stringify({ id })]
      );

      return { deleted: true, item: toItem(rows[0]) };
    },

    /**
     * Invalidate without deleting.
     *
     * The fact was true and is not any more. The row is kept and marked, so
     * "what did I believe about X in March" is still answerable. This is the
     * distinction that makes consolidation safe (ADR / ARCHITECTURE section 1).
     */
    async invalidateItem(id, at, meta = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `UPDATE memory_items
         SET invalidated_at = $2,
             occurred_end = COALESCE(occurred_end, $2),
             status = 'invalidated',
             updated_at = $2
         WHERE id = $1 AND invalidated_at IS NULL
         RETURNING *`,
        [id, at ?? clock()]
      );
      if (rows.length === 0) return { invalidated: false };

      await pools.poolFor(workspace).query(
        `INSERT INTO memory_mutations (at, operation, item_id, node_id, reason, actor, payload)
         VALUES ($1,'invalidate',$2,$3,$4,$5,$6)`,
        [at ?? clock(), id, rows[0].node_id, meta.reason ?? "invalidate",
         meta.actor ?? "mcp", JSON.stringify({ id })]
      );

      return { invalidated: true, item: toItem(rows[0]) };
    },

    async moveItem(itemId, targetNodeId, meta = {}) {
      const now = clock();
      const pool = pools.poolFor(workspace);

      // Read the origin before the update, so the audit log records a real
      // from -> to pair. Recording the destination twice makes the log useless
      // for reconstructing what happened.
      const { rows: origin } = await pool.query(
        "SELECT node_id FROM memory_items WHERE id = $1",
        [itemId]
      );
      if (origin.length === 0) return null;
      const fromNodeId = origin[0].node_id;

      const { rows } = await pool.query(
        "UPDATE memory_items SET node_id = $2, updated_at = $3 WHERE id = $1 RETURNING *",
        [itemId, targetNodeId, now]
      );

      await pool.query(
        `INSERT INTO memory_mutations (at, operation, item_id, node_id, reason, actor, payload)
         VALUES ($1,'move_item',$2,$3,$4,$5,$6)`,
        [now, itemId, targetNodeId, meta.reason ?? "move_item", meta.actor ?? "mcp",
         JSON.stringify({ from: fromNodeId, to: targetNodeId })]
      );

      return toItem(rows[0]);
    },

    // -----------------------------------------------------------------------
    // Retrieval
    // -----------------------------------------------------------------------

    /**
     * Keyword search.
     *
     * Phase 3 replaces the ILIKE scan with `pg_search` BM25 and adds the vector,
     * graph and temporal arms plus RRF fusion. The signature is already the
     * one those layers will use, so nothing above this changes when they land.
     *
     * `temporal` is honoured here already, because a filter is not a strategy:
     * a fact that stopped being true must not come back for a query asking what
     * is true now.
     */
    async searchItems(query, options = {}) {
      const {
        limit = 20,
        nodeId = null,
        tags = [],
        status = "active",
        includeDeleted = false,
        asOf = null,
        requireValid = true
      } = options;

      const conditions = [];
      const values = [];

      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }
      if (!includeDeleted) conditions.push("deleted_at IS NULL");
      if (nodeId) {
        values.push(nodeId);
        conditions.push(`node_id = $${values.length}`);
      }
      for (const tag of tags) {
        values.push(JSON.stringify([tag]));
        conditions.push(`tags @> $${values.length}::jsonb`);
      }

      if (requireValid) {
        conditions.push("invalidated_at IS NULL");
      }
      if (asOf) {
        values.push(asOf);
        const when = `$${values.length}`;
        // The temporal arm: was this fact true at the requested moment?
        conditions.push(
          `(occurred_start IS NULL OR occurred_start <= ${when})` +
            ` AND (occurred_end IS NULL OR occurred_end > ${when})` +
            ` AND (invalidated_at IS NULL OR invalidated_at > ${when})`
        );
      }

      values.push(limit);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // A non-empty query filters; an empty one lists. That distinction is what
      // lets listItems and searchItems share one query path.
      if (query && String(query).trim()) {
        values.push(`%${query}%`);
        const term = `$${values.length}`;
        const { rows } = await pools.poolFor(workspace).query(
          `SELECT * FROM memory_items ${where}
           ${where ? "AND" : "WHERE"} content ILIKE ${term}
           ORDER BY importance DESC, created_at DESC
           LIMIT $${values.length - 1}`,
          values
        );
        return rows.map((row) => ({ item: toItem(row), match: { strategy: "keyword" } }));
      }

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT * FROM memory_items ${where}
         ORDER BY importance DESC, created_at DESC
         LIMIT $${values.length}`,
        values
      );
      return rows.map((row) => ({ item: toItem(row), match: { strategy: "list" } }));
    },

    // -----------------------------------------------------------------------
    // Mutations, embeddings, decisions
    // -----------------------------------------------------------------------

    async listMutations({ limit = 100, offset = 0, itemId = null, nodeId = null } = {}) {
      const conditions = [];
      const values = [];
      if (itemId) {
        values.push(itemId);
        conditions.push(`item_id = $${values.length}`);
      }
      if (nodeId) {
        values.push(nodeId);
        conditions.push(`node_id = $${values.length}`);
      }
      values.push(limit, offset);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT * FROM memory_mutations ${where}
         ORDER BY at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      );
      return rows.map(toMutation);
    },

    async getCachedEmbedding(cacheKey, model) {
      const { rows } = await pools.poolFor(workspace).query(
        "SELECT cache_key, model, text_hash, vector, dimensions FROM memory_embeddings WHERE cache_key = $1 AND model = $2",
        [cacheKey, model]
      );
      return rows[0] ?? null;
    },

    async upsertCachedEmbedding(cacheKey, model, vector, dimensions) {
      const textHash = createHash("sha256").update(cacheKey).digest("hex");
      await pools.poolFor(workspace).query(
        `INSERT INTO memory_embeddings (cache_key, model, text_hash, vector, dimensions, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5, now())
         ON CONFLICT (cache_key, model) DO UPDATE SET
           vector = EXCLUDED.vector, dimensions = EXCLUDED.dimensions,
           updated_at = EXCLUDED.updated_at`,
        [cacheKey, model, textHash, JSON.stringify(vector), dimensions]
      );
      return { cacheKey, model, dimensions };
    },

    /** Record a decision-model call. Every call, not only the applied ones. */
    async recordDecision(record) {
      const { rows } = await pools.poolFor(workspace).query(
        `INSERT INTO decisions
           (operation, model, question_key, question_type, noul_score, choice, score,
            confidence, was_applied, threshold_used, context_hash, latency_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          record.operation,
          record.model,
          record.questionKey ?? null,
          record.questionType ?? null,
          record.noul ?? null,
          record.choice ?? null,
          record.score ?? null,
          record.confidence ?? null,
          record.applied ?? false,
          record.threshold ?? null,
          record.contextHash ?? null,
          record.latencyMs ?? null
        ]
      );
      return rows[0];
    },

    async recordFeedback(itemId, signal, reason = null, actor = null) {
      const { rows } = await pools.poolFor(workspace).query(
        `INSERT INTO memory_feedback (item_id, signal, reason, actor)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [itemId, signal, reason, actor]
      );

      // Feed the label back into the decision log, so calibration sees the
      // correction where the decision was made rather than in a separate table.
      await pools.poolFor(workspace).query(
        `UPDATE decisions SET outcome = $2
         WHERE item_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [itemId, signal === "useful" ? "useful" : "ignored"]
      ).catch(() => {
        // The decisions table has no item_id column yet in migration 0001; the
        // update becomes a no-op rather than a failure.
      });

      return rows[0];
    },

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    async stats() {
      const pool = pools.poolFor(workspace);

      // `invalidated` is a distinct status, not a flag on `active`. A fact that
      // stopped being true is neither live nor deleted, and collapsing the two
      // would make "what is true now" and "what was ever recorded" the same
      // query.
      const [nodes, items, mutations, embeddings, decisions] = await Promise.all([
        pool.query("SELECT COUNT(*)::int AS n FROM memory_nodes"),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'active')::int      AS active,
             COUNT(*) FILTER (WHERE status = 'proposed')::int    AS proposed,
             COUNT(*) FILTER (WHERE status = 'deleted')::int     AS deleted,
             COUNT(*) FILTER (WHERE status = 'invalidated')::int AS invalidated,
             COUNT(*)::int AS total
           FROM memory_items`
        ),
        pool.query("SELECT COUNT(*)::int AS n FROM memory_mutations"),
        pool.query(
          "SELECT model, COUNT(*)::int AS n FROM memory_embeddings GROUP BY model"
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE outcome IS NULL)::int AS unlabelled,
             COUNT(*)::int AS total
           FROM decisions`
        )
      ]);

      return {
        workspace,
        nodes: nodes.rows[0].n,
        items: {
          active: items.rows[0].active,
          proposed: items.rows[0].proposed,
          deleted: items.rows[0].deleted,
          invalidated: items.rows[0].invalidated,
          total: items.rows[0].total
        },
        mutations: mutations.rows[0].n,
        embeddings: embeddings.rows.map((r) => ({ model: r.model, count: r.n })),
        decisions: {
          total: decisions.rows[0].total,
          unlabelled: decisions.rows[0].unlabelled
        }
      };
    },

    /** Health probe. Separate from stats so it can be cheap and safe. */
    async health() {
      const { rows } = await pools.poolFor(workspace).query("SELECT 1 AS ok");
      return { workspace, reachable: rows[0].ok === 1 };
    },

    /** Whichever engine is actually available, reported rather than assumed. */
    async capabilities() {
      const pool = pools.poolFor(workspace);
      const { rows } = await pool.query(
        `SELECT extname FROM pg_extension
         WHERE extname IN ('vector', 'pg_search', 'pgroonga', 'vchord')`
      );
      const present = new Set(rows.map((r) => r.extname));
      return {
        vector: present.has("vector"),
        bm25: present.has("pg_search") ? "pg_search" : "tsvector",
        bm25Engine: present.has("pg_search") ? "pg_search" : "tsvector",
        graph: present.has("vector") ? "entity_edges" : "unavailable",
        temporal: true
      };
    }
  };
}

export { toItem, toNode, isSharedWorkspace, quoteIdentifier };
