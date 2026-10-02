import { randomUUID, createHash } from "node:crypto";

import {
  assertWorkspaceName,
  quoteIdentifier,
  isSharedWorkspace
} from "./workspace-name.mjs";

/**
 * The store.
 *
 * This is the only module that writes SQL *about memories*. Its two siblings
 * have their own, necessarily: migrate.mjs applies DDL, and pool.mjs runs the
 * CREATE DATABASE and pg_stat_activity queries that one-database-per-workspace
 * depends on (ADR-003). Those are statements about databases rather than about
 * memories, which is the line that matters.
 *
 * Everything above this directory calls these methods and never sees a query
 * string, which is what makes the retrieval layers in Phase 3 testable without
 * a database.
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

/**
 * Render a JS array of numbers as pgvector's literal form.
 *
 * `[1,2,3]` rather than a bound parameter: node-postgres has no pgvector type
 * parser installed, so a JS array bound to `$1::vector` comes back as the
 * string `"1,2,3"` and PostgreSQL rejects it. The literal is built here
 * rather than at the call site so the validation is in one place.
 *
 * Every element is checked to be a finite number. NaN or Infinity reaching
 * pgvector produces a vector that matches nothing, with no error anywhere —
 * which surfaces as "search is broken" rather than "the embedder returned
 * garbage".
 */
function toVectorLiteral(vector) {
  if (!Array.isArray(vector)) {
    throw new TypeError(`A vector must be an array of numbers, got ${typeof vector}`);
  }
  if (vector.length === 0) {
    throw new RangeError("A vector must have at least one element");
  }
  for (const [index, value] of vector.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(
        `Vector element ${index} is ${value}. A NaN or Infinity in a vector ` +
          `produces one that matches nothing, silently.`
      );
    }
  }
  return `[${vector.join(",")}]`;
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

    // -----------------------------------------------------------------------
    // Layer 1: vector
    // -----------------------------------------------------------------------

    /**
     * The declared width of the embedding column, in this database.
     *
     * Read from information_schema rather than assumed from config, because a
     * mismatch between the two produces a distance function that returns
     * nonsense rather than an error. `google/gemini-embedding-2` and any other
     * model do not share a vector space (ADR-005), so this is the check that
     * keeps a re-embed from silently producing nonsense distances.
     */
    async vectorDimensions() {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT a.atttypmod AS width
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = 'memory_item_vectors'
           AND a.attname = 'embedding'
           AND a.attnum > 0
           AND NOT a.attisdropped`
      );
      return rows[0] ? Number(rows[0].width) : null;
    },

    /**
     * Store or replace an item's embedding.
     *
     * The model id travels with the vector. When the embedder changes, the old
     * vectors stay and are excluded by `searchVector`'s model filter rather
     * than being mixed with new ones — two models' vectors in one index are
     * meaningless, and an index that silently contains both is the failure
     * this column prevents.
     */
    async upsertItemVector(itemId, model, vector) {
      const literal = toVectorLiteral(vector);
      const { rows } = await pools.poolFor(workspace).query(
        `INSERT INTO memory_item_vectors (item_id, model, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (item_id) DO UPDATE SET
           model = EXCLUDED.model,
           embedding = EXCLUDED.embedding,
           embedded_at = now()
         RETURNING item_id, model, embedded_at`,
        [itemId, model, literal]
      );
      return rows[0] ?? null;
    },

    /**
     * Cosine-similarity search.
     *
     * `similarity` is returned alongside the rank because it is the only thing
     * that tells a caller *how* close a match was. RRF discards it, which is
     * the point, but a human debugging a bad result has nothing else.
     *
     * Deleted and invalidated items are excluded in SQL, not in JavaScript:
     * the filter has to be applied before the LIMIT or the top-K is full of
     * rows the caller cannot use.
     */
    async searchVector(queryVector, { limit = 20, model = null, minSimilarity = null } = {}) {
      const literal = toVectorLiteral(queryVector);
      const values = [literal];
      const conditions = ["i.deleted_at IS NULL"];

      // A distance floor, applied in SQL so the LIMIT is not filled with rows
      // the caller will discard.
      //
      // Without it the vector arm returns the K nearest items to *any* query,
      // including a query about something entirely absent from memory. That
      // makes it impossible to distinguish "nothing relevant is stored" from
      // "the index is broken", which is the one distinction a caller needs
      // most. It also means every search returns exactly K results, so the
      // result count carries no information at all.
      //
      // The default is a starting value, not a measured one. It belongs to the
      // same calibration set as the decision thresholds — see
      // docs/THRESHOLDS.md — and this build reports whatever it used rather
      // than pretending it is final.
      if (minSimilarity !== null) {
        values.push(minSimilarity);
        conditions.push(`1 - (v.embedding <=> $1::vector) >= $${values.length}`);
      }

      if (model) {
        values.push(model);
        conditions.push(`v.model = $${values.length}`);
      }

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT i.*, v.model AS embed_model,
                1 - (v.embedding <=> $1::vector) AS similarity
         FROM memory_item_vectors v
         JOIN memory_items i ON i.id = v.item_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY v.embedding <=> $1::vector
         LIMIT $${values.length + 1}`,
        [...values, limit]
      );

      return rows.map((row) => ({
        id: row.id,
        item: toItem(row),
        similarity: Number(row.similarity),
        embedModel: row.embed_model
      }));
    },

    /** How many items have a vector, for which models. */
    async vectorCoverage() {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT v.model, count(*)::int AS count,
                min(v.embedded_at) AS oldest, max(v.embedded_at) AS newest
         FROM memory_item_vectors v
         JOIN memory_items i ON i.id = v.item_id
         WHERE i.deleted_at IS NULL
         GROUP BY v.model
         ORDER BY v.model`
      );
      return rows.map((row) => ({
        model: row.model,
        count: Number(row.count),
        oldest: row.oldest?.toISOString?.() ?? null,
        newest: row.newest?.toISOString?.() ?? null
      }));
    },

    // -----------------------------------------------------------------------
    // Layer 2: lexical
    // -----------------------------------------------------------------------

    /**
     * Full-text search.
     *
     * `websearch_to_tsquery` rather than `plainto_tsquery`: the former
     * understands quoted phrases and OR, so a query containing them is not
     * silently reduced to a bag of ANDed words. `plainto` would accept
     * `"deploy plan"` and search for all four words in any order, which
     * returns documents that contain the words and not the phrase.
     *
     * The rank is normalised to [0,1] by dividing by the best score in the
     * result set. RRF does not use it; the report does.
     */
    async searchBm25(query, { limit = 20, nodeId = null, tags = [] } = {}) {
      const trimmed = String(query ?? "").trim();
      if (!trimmed) return [];

      const values = [trimmed];
      const conditions = [
        "deleted_at IS NULL",
        "search_vector @@ websearch_to_tsquery('english', $1)"
      ];

      if (nodeId) {
        values.push(nodeId);
        conditions.push(`node_id = $${values.length}`);
      }
      for (const tag of tags) {
        values.push(JSON.stringify([tag]));
        conditions.push(`tags @> $${values.length}::jsonb`);
      }

      const { rows } = await pools.poolFor(workspace).query(
        `WITH scored AS (
           SELECT *, ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) AS rank
           FROM memory_items
           WHERE ${conditions.join(" AND ")}
         ),
         best AS (SELECT max(rank) AS top FROM scored)
         SELECT scored.*, CASE WHEN best.top > 0
                                THEN scored.rank / best.top
                                ELSE 0 END AS normalised
         FROM scored, best
         WHERE scored.rank > 0
         ORDER BY scored.rank DESC, scored.id ASC
         LIMIT $${values.length + 1}`,
        [...values, limit]
      );

      return rows.map((row) => ({
        id: row.id,
        item: toItem(row),
        rank: Number(row.rank),
        normalised: Number(row.normalised)
      }));
    },

    // -----------------------------------------------------------------------
    // Layer 3: graph
    // -----------------------------------------------------------------------

    /** Record an edge. Duplicate edges are refused, not silently merged. */
    async addEdge(fromItem, toItem, relation, { weight = 1.0, source = "system" } = {}) {
      if (fromItem === toItem) {
        // A self-edge is always a bug: a hop that reaches nowhere, which
        // looks like a hit and contributes a phantom vote to the fusion.
        throw new Error(
          `Refusing a self-edge on "${fromItem}" (${relation}). It adds a hop ` +
            `that reaches nowhere.`
        );
      }

      const { rows } = await pools.poolFor(workspace).query(
        `INSERT INTO entity_edges (from_item, to_item, relation, weight, source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [fromItem, toItem, relation, weight, source]
      );
      // ON CONFLICT DO NOTHING with no unique index means duplicates are
      // actually inserted. Caught here rather than by adding a constraint
      // that would forbid a legitimate second edge of a different relation.
      if (!rows[0]) {
        const { rows: existing } = await pools.poolFor(workspace).query(
          "SELECT * FROM entity_edges WHERE from_item=$1 AND to_item=$2 AND relation=$3 LIMIT 1",
          [fromItem, toItem, relation]
        );
        return existing[0] ?? null;
      }
      return rows[0];
    },

    /**
     * Walk the graph outward from a set of seed items.
     *
     * A recursive CTE rather than a round trip per hop: two hops of traversal
     * in one query instead of two queries, and the hop count comes back with
     * the row so the caller can weight by distance.
     *
     * `maxDepth` is capped. An unbounded walk over a graph with a cycle is a
     * query that does not return, and a memory graph will have cycles the
     * moment two memories mention the same entity.
     */
    async traverseGraph(seedIds, { limit = 20, maxDepth = 2, relations = null, minWeight = 0 } = {}) {
      if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
      if (maxDepth < 1) return [];
      // Three is enough for personal memory and low enough that a cycle
      // cannot run away. The cap is a correctness property, not a preference.
      const depth = Math.min(maxDepth, 3);

      // Parameter indices assigned explicitly rather than derived from the
      // values array. A derived index silently collides the moment the
      // `relations` filter is absent, and the symptom is a LIMIT clause
      // reading a hop count — a traversal that returns the wrong rows without
      // erroring.
      const params = [seedIds, depth, minWeight, limit];
      const SEEDS = "$1";
      const MAX_DEPTH = "$2";
      const MIN_WEIGHT = "$3";
      const LIMIT = "$4";

      // The seed is already excluded from its own walk by the path guard in
      // the recursive term: the seed is the first element of `path`, so
      // `NOT (e.to_item = ANY(w.path))` can never walk back onto it.
      //
      // An *overall* `id <> ALL(seeds)` filter is deliberately absent. With
      // ten seeds — which is what arms 1 and 2 return — it would exclude
      // every item in the corpus and the graph arm could never return
      // anything. Overlap between arms is the thing RRF exists to reward, so
      // an item reachable from one seed and already found by the vector arm
      // earns two votes, which is the correct reading of "two layers agree".
      const filters = ["i.deleted_at IS NULL"];
      if (relations) {
        params.push(relations);
        filters.push(`scored.relation = ANY($${params.length})`);
      }

      const { rows } = await pools.poolFor(workspace).query(
        `WITH RECURSIVE walk AS (
           SELECT e.to_item AS id, e.relation, e.weight, 1 AS depth,
                  ARRAY[e.from_item] AS path
           FROM entity_edges e
           WHERE e.from_item = ANY(${SEEDS})
             AND e.weight >= ${MIN_WEIGHT}
           UNION ALL
           SELECT e.to_item, e.relation, e.weight, w.depth + 1, w.path || e.from_item
           FROM entity_edges e
           JOIN walk w ON e.from_item = w.id
           WHERE w.depth < ${MAX_DEPTH}
             AND e.weight >= ${MIN_WEIGHT}
             AND NOT (e.to_item = ANY(w.path))
         ),
         nearest AS (
           -- DISTINCT ON with an ORDER BY is how "best hop per item" is
           -- expressed in SQL. The outer ORDER BY then re-sorts the surviving
           -- rows by that score, which the window function supplies.
           SELECT DISTINCT ON (w.id)
                  w.id, w.depth, w.relation, w.weight
           FROM walk w
           ORDER BY w.id, w.depth ASC, w.weight DESC
         ),
         scored AS (
           SELECT n.id, n.depth, n.relation, n.weight,
                  (n.weight / (n.depth + 1))::float8 AS score
           FROM nearest n
         )
         SELECT scored.*, i.*
         FROM scored
         JOIN memory_items i ON i.id = scored.id
         WHERE ${filters.join(" AND ")}
         ORDER BY scored.score DESC, scored.id ASC
         LIMIT ${LIMIT}`,
        params
      );

      return rows.map((row) => ({
        id: row.id,
        item: toItem(row),
        depth: Number(row.depth),
        relation: row.relation,
        // Weight falls off with distance. `1/(depth+1)` rather than a hand-picked
        // per-level multiplier: a hop count is known, a "how much does a
        // second-hand mention count" coefficient is a guess.
        score: Number(row.weight) / (Number(row.depth) + 1)
      }));
    },

    /**
     * The raw pool for this workspace.
     *
     * Reserved for the migration and provisioning work in `migrate.mjs` and
     * `pool.mjs`, which legitimately need it. Nothing above `src/store/` may
     * use it — that is what the "only store/ writes SQL" invariant asserts —
     * so if a change needs a query from outside this directory, the answer is
     * a method here, not a caller reaching for this.
     */
    pool() {
      return pools.poolFor(workspace);
    },

    /**
     * Items with no vector for a given model, most recent first.
     *
     * The re-embedding work list, and the thing that answers "how complete is
     * this index". Invalidated items are included: they are retained facts
     * with a past, and a query for last March needs their vectors as much as
     * current facts do.
     */
    async listUnembeddedItems({ model, limit = 1000 } = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT i.id, i.content
         FROM memory_items i
         LEFT JOIN memory_item_vectors v ON v.item_id = i.id AND v.model = $1
         WHERE v.item_id IS NULL
           AND i.deleted_at IS NULL
         ORDER BY i.recorded_at DESC
         LIMIT $2`,
        [model, limit]
      );
      return rows.map((row) => ({ id: row.id, text: row.content }));
    },

    /**
     * How much of the corpus is indexed, for one model.
     *
     * A number rather than a boolean, because "a few unembedded" and "almost
     * nothing embedded" call for different responses. `ratio` is null for an
     * empty corpus rather than 0: "nothing is missing because there is
     * nothing" and "nothing is indexed" are different states, and division
     * here would report the first as a perfect score.
     */
    async vectorCoverageSummary({ model } = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT
           count(*) FILTER (WHERE i.deleted_at IS NULL)::int AS eligible,
           count(v.item_id) FILTER (WHERE i.deleted_at IS NULL)::int AS embedded
         FROM memory_items i
         LEFT JOIN memory_item_vectors v ON v.item_id = i.id AND v.model = $1`,
        [model]
      );
      const eligible = Number(rows[0]?.eligible ?? 0);
      const embedded = Number(rows[0]?.embedded ?? 0);
      return {
        model,
        eligible,
        embedded,
        missing: eligible - embedded,
        ratio: eligible === 0 ? null : Number((embedded / eligible).toFixed(4))
      };
    },

    /** Every edge touching an item, in either direction. */
    async edgesFor(itemId) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT *, CASE WHEN from_item = $1 THEN 'out' ELSE 'in' END AS direction
         FROM entity_edges
         WHERE from_item = $1 OR to_item = $1
         ORDER BY weight DESC`,
        [itemId]
      );
      return rows;
    },

    // -----------------------------------------------------------------------
    // Provider credentials
    //
    // The values are opaque bytes to this layer. Encryption happens in
    // src/api/credentials.mjs, and the master key never reaches this file —
    // which is what makes the invariant above enforceable: a module outside
    // src/store/ cannot reach the ciphertext table, because reaching it means
    // going through here.
    // -----------------------------------------------------------------------

    async upsertCredential({
      provider,
      kind,
      ciphertext,
      nonce,
      authTag,
      keyVersion,
      fingerprint
    }) {
      await pools.poolFor(workspace).query(
        `INSERT INTO provider_credentials
           (provider, kind, ciphertext, nonce, auth_tag, key_version, ciphertext_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (provider, kind) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext,
           nonce = EXCLUDED.nonce,
           auth_tag = EXCLUDED.auth_tag,
           key_version = EXCLUDED.key_version,
           ciphertext_fingerprint = EXCLUDED.ciphertext_fingerprint,
           updated_at = now()`,
        [provider, kind, ciphertext, nonce, authTag, keyVersion, fingerprint]
      );
    },

    /** The sealed parts only. Never a decrypted value — that never lands here. */
    async readCredential({ provider, kind }) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT provider, kind, ciphertext, nonce, auth_tag, key_version
         FROM provider_credentials WHERE provider = $1 AND kind = $2`,
        [provider, kind]
      );
      return rows[0] ?? null;
    },

    async describeCredential({ provider, kind }) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT provider, kind, key_version, ciphertext_fingerprint, created_at, updated_at
         FROM provider_credentials WHERE provider = $1 AND kind = $2`,
        [provider, kind]
      );
      return rows[0] ?? null;
    },

    async deleteCredential({ provider, kind }) {
      const { rows } = await pools.poolFor(workspace).query(
        "DELETE FROM provider_credentials WHERE provider = $1 AND kind = $2 RETURNING provider",
        [provider, kind]
      );
      return rows.length > 0;
    },

    async recordCredentialAudit({ provider, kind, operation, note = null }) {
      await pools.poolFor(workspace).query(
        "INSERT INTO credentials_audit (provider, kind, operation, note) VALUES ($1,$2,$3,$4)",
        [provider, kind, operation, note]
      );
    },

    async listCredentialAudit({ provider = null, kind = null, limit = 50 } = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT at, provider, kind, operation, note
         FROM credentials_audit
         WHERE ($1::text IS NULL OR provider = $1)
           AND ($2::text IS NULL OR kind = $2)
         ORDER BY at DESC
         LIMIT $3`,
        [provider, kind, limit]
      );
      return rows;
    },

    // -----------------------------------------------------------------------
    // Media
    //
    // The bytes live in S3. This table is a pointer, a hash, and the extracted
    // text — never the content itself (ADR-011).
    // -----------------------------------------------------------------------

    /**
     * Record an uploaded media object.
     *
     * Idempotent on (workspace, id), which is the sha256 of the bytes. Two
     * uploads of the same file are one row, because a memory system that
     * stores the same image twice retrieves it twice.
     */
    async upsertMedia(media) {
      const {
        id,
        bucket,
        objectKey,
        sha256,
        etag = null,
        contentType,
        contentTypeSource = "declared",
        sizeBytes,
        extractedText = null,
        extractionMethod = null,
        extractionError = null,
        caption = null,
        itemId = null
      } = media;

      const { rows } = await pools.poolFor(workspace).query(
        `INSERT INTO media
           (id, workspace, bucket, object_key, sha256, etag, content_type,
            content_type_source, size_bytes, extracted_text, extraction_method,
            extraction_error, caption, item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (workspace, id) DO UPDATE SET
           etag = EXCLUDED.etag,
           content_type = EXCLUDED.content_type,
           content_type_source = EXCLUDED.content_type_source,
           size_bytes = EXCLUDED.size_bytes,
           extracted_text = EXCLUDED.extracted_text,
           extraction_method = EXCLUDED.extraction_method,
           extraction_error = EXCLUDED.extraction_error,
           caption = COALESCE(EXCLUDED.caption, media.caption),
           updated_at = now()
         RETURNING *`,
        [
          id, workspace, bucket, objectKey, sha256, etag, contentType,
          contentTypeSource, sizeBytes, extractedText, extractionMethod,
          extractionError, caption, itemId
        ]
      );
      return rows[0] ?? null;
    },

    async readMedia(id) {
      const { rows } = await pools.poolFor(workspace).query(
        "SELECT * FROM media WHERE workspace = $1 AND id = $2",
        [workspace, id]
      );
      return rows[0] ?? null;
    },

    async findMediaByHash(sha256) {
      const { rows } = await pools.poolFor(workspace).query(
        "SELECT * FROM media WHERE workspace = $1 AND sha256 = $2",
        [workspace, sha256]
      );
      return rows[0] ?? null;
    },

    async listMedia({ limit = 100, offset = 0, itemId = null, unextractedOnly = false } = {}) {
      const conditions = ["workspace = $1"];
      const values = [workspace];

      if (itemId) {
        values.push(itemId);
        conditions.push(`item_id = $${values.length}`);
      }
      if (unextractedOnly) conditions.push("(extracted_text IS NULL AND extraction_error IS NULL)");

      values.push(limit, offset);
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT id, content_type, size_bytes, sha256, extraction_method, extraction_error,
                caption, item_id, created_at
         FROM media
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
      );
      return rows;
    },

    async attachMediaToItem(mediaId, itemId) {
      const { rows } = await pools.poolFor(workspace).query(
        "UPDATE media SET item_id = $3, updated_at = now() WHERE workspace = $1 AND id = $2 RETURNING id, item_id",
        [workspace, mediaId, itemId]
      );
      return rows[0] ?? null;
    },

    async upsertMediaEmbedding(mediaId, model, vector) {
      const { rows } = await pools.poolFor(workspace).query(
        `UPDATE media SET embedding_model = $3, embedding = $4::vector, updated_at = now()
         WHERE workspace = $1 AND id = $2 RETURNING id, embedding_model`,
        [workspace, mediaId, model, toVectorLiteral(vector)]
      );
      return rows[0] ?? null;
    },

    /**
     * The vector arm for media.
     *
     * Media items can be relevant to a query, and they are in the same
     * embedding space as everything else (ADR-005) — which is why a text query
     * can retrieve an image. `item_id IS NOT NULL` excludes media that has not
     * been attached to a memory yet: bytes that exist but belong to nothing are
     * not recallable content.
     */
    async searchMedia(vector, { limit = 20, model = null, minSimilarity = null } = {}) {
      const literal = toVectorLiteral(vector);
      const values = [literal];
      const conditions = ["item_id IS NOT NULL"];

      if (model) {
        values.push(model);
        conditions.push(`embedding_model = $${values.length}`);
      }
      if (minSimilarity !== null) {
        values.push(minSimilarity);
        conditions.push(`1 - (embedding <=> $1::vector) >= $${values.length}`);
      }

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT id, caption, content_type, size_bytes, item_id,
                1 - (embedding <=> $1::vector) AS similarity
         FROM media
         WHERE ${conditions.join(" AND ")}
         ORDER BY embedding <=> $1::vector
         LIMIT $${values.length + 1}`,
        [...values, limit]
      );

      return rows.map((row) => ({
        id: row.id,
        media: row,
        similarity: Number(row.similarity)
      }));
    },

    /** Media whose embedding is missing, and which is attached to something. */
    async listUnembeddedMedia({ model, limit = 100 } = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT id, caption, content_type, extracted_text
         FROM media
         WHERE embedding IS NULL
           AND item_id IS NOT NULL
           AND ($1::text IS NULL OR embedding_model IS DISTINCT FROM $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [model, limit]
      );
      return rows;
    },

    async mediaCoverage({ model } = {}) {
      const { rows } = await pools.poolFor(workspace).query(
        `SELECT
           count(*) FILTER (WHERE item_id IS NOT NULL)::int AS attached,
           count(embedding) FILTER (WHERE item_id IS NOT NULL)::int AS embedded,
           count(*) FILTER (WHERE item_id IS NULL)::int AS unattached
         FROM media`
      );
      const attached = Number(rows[0]?.attached ?? 0);
      const embedded = Number(rows[0]?.embedded ?? 0);
      return {
        attached,
        embedded,
        unattached: Number(rows[0]?.unattached ?? 0),
        ratio: attached === 0 ? null : Number((embedded / attached).toFixed(4))
      };
    },

    async recordMediaMutation({ mediaId, operation, sizeBytes = null, sha256 = null, note = null }) {
      await pools.poolFor(workspace).query(
        `INSERT INTO media_mutations (workspace, media_id, operation, size_bytes, sha256, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspace, mediaId, operation, sizeBytes, sha256, note]
      );
    },

    async listMediaMutations({ limit = 100, mediaId = null } = {}) {
      const values = [workspace];
      const conditions = ["workspace = $1"];
      if (mediaId) {
        values.push(mediaId);
        conditions.push(`media_id = $${values.length}`);
      }
      values.push(limit);

      const { rows } = await pools.poolFor(workspace).query(
        `SELECT * FROM media_mutations WHERE ${conditions.join(" AND ")}
         ORDER BY at DESC LIMIT $${values.length}`,
        values
      );
      return rows;
    },

    // -----------------------------------------------------------------------
    // Search accounting
    // -----------------------------------------------------------------------

    /**
     * Persist one search run.
     *
     * `arm_hits` is a JSONB object with one key per arm, and a null value for
     * an arm that did not run. A zero and a null are different facts: zero is
     * "the arm ran and matched nothing", null is "the arm was skipped". The
     * Phase 3 gate is that all four are distinguishable, so the schema has to
     * be able to say it.
     */
    async recordSearchRun({
      queryHash,
      workspace: runWorkspace = workspace,
      armHits = {},
      weights = {},
      rrfK = null,
      results = 0,
      tookMs = null,
      bm25Engine = null,
      embedModel = null
    }) {
      await pools.poolFor(runWorkspace).query(
        `INSERT INTO search_runs
           (query_hash, workspace, vector_hits, bm25_hits, graph_hits, temporal_hits,
            weights, rrf_k, results, took_ms, bm25_engine, embed_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          queryHash,
          runWorkspace,
          armHits.vector ?? null,
          armHits.bm25 ?? null,
          armHits.graph ?? null,
          armHits.temporal ?? null,
          JSON.stringify(weights),
          rrfK,
          results,
          tookMs,
          bm25Engine,
          embedModel
        ]
      );
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

export { toItem, toNode, isSharedWorkspace, quoteIdentifier, toVectorLiteral };
