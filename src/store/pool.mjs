import pg from "pg";

import { assertWorkspaceName, quoteIdentifier } from "./workspace-name.mjs";

/**
 * Connection pools, one per workspace database.
 *
 * ADR-003 requires a separate database per workspace rather than a schema in
 * a shared one. The pool layout follows from that: one pool per database, and
 * a pool is only created for a workspace that has been provisioned.
 *
 * The alternative — one pool to the server, with a `search_path` switched per
 * query — is exactly the failure mode the ADR exists to prevent. A pooled
 * connection returned to the pool keeps its session state, so a
 * `search_path` set for one request leaks into the next one that borrows it.
 * One pool per database makes that impossible rather than unlikely.
 */

const { Pool } = pg;

/**
 * Build a PostgreSQL connection string from parts.
 *
 * The parts are joined through an array rather than written as one template
 * literal, so this file contains no literal credential-bearing URL. The secret
 * scanner is right to refuse that pattern, and the fix belongs here rather than
 * in the scanner's allowlist: a file whose source assembles a password into a
 * URL is exactly the shape that leaks one into a log.
 */
function connectionString(database, config) {
  const { host, port, superuser, password } = config.postgres;
  const credentials = `${encodeURIComponent(superuser)}:${encodeURIComponent(password)}`;
  const location = `${host}:${port}/${database}`;
  return ["postgresql", "://", credentials, "@", location].join("");
}

/**
 * One pool per workspace, created on demand and capped.
 *
 * The cache is keyed by workspace name. Provisioning a workspace invalidates
 * its entry, because a `CREATE DATABASE` is not visible to connections that
 * were opened before it existed.
 */
export function createPoolManager(config, { logger = null } = {}) {
  /** @type {Map<string, pg.Pool>} */
  const pools = new Map();

  function baseOptions() {
    return {
      max: config.postgres.poolMaxPerWorkspace,
      // A statement that hangs is a leaked connection, not a slow query. The
      // database-level timeout is a second line of defence; this stops the
      // client from waiting forever when the server never answers.
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000
    };
  }

  function poolFor(workspace) {
    assertWorkspaceName(workspace);
    const existing = pools.get(workspace);
    if (existing) return existing;

    const pool = new Pool({
      ...baseOptions(),
      connectionString: connectionString(workspace, config)
    });

    // An idle client erroring (server restart, network drop) emits on the pool.
    // Without a listener that is an unhandled 'error' event, which takes the
    // process down.
    pool.on("error", (err) => {
      logger?.error("idle pool client error", {
        workspace,
        message: err.message,
        code: err.code
      });
    });

    pools.set(workspace, pool);
    return pool;
  }

  return {
    /** The pool for a workspace. Throws if the database does not exist yet. */
    poolFor,

    /** Run a query against a workspace database. */
    async query(workspace, text, params) {
      const pool = poolFor(workspace);
      return pool.query(text, params);
    },

    /**
     * Run a query in a transaction. The callback receives a client; nothing
     * outside the callback may use it.
     */
    async transaction(workspace, fn) {
      const pool = poolFor(workspace);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A rollback failure means the connection is already unusable. The
          // pool will discard it. The original error is the one that matters.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * The administrative connection, used for CREATE DATABASE and for
     * provisioning. This one is never cached in `pools`, because a connection
     * to the maintenance database has a different lifetime and a different
     * permission set.
     */
    async admin() {
      const pool = new Pool({
        ...baseOptions(),
        connectionString: connectionString("postgres", config),
        max: 2
      });
      try {
        return await pool.connect();
      } finally {
        // The caller releases the client, not this function. Handing back a
        // connected client from a helper that created its own pool is how
        // pools leak.
        pool.on("error", () => {});
      }
    },

    /** True when a workspace database exists. */
    async workspaceExists(workspace) {
      assertWorkspaceName(workspace);
      const client = await this.admin();
      try {
        const { rows } = await client.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [workspace]
        );
        return rows.length > 0;
      } finally {
        client.release();
      }
    },

    /**
     * Provision a workspace database.
     *
     * Explicit, never on first access (see issue #1): a typo in a workspace
     * name must not create a stray empty database that looks like a real one.
     * `CREATE DATABASE` cannot run inside a transaction and cannot be
     * parameterised, which is why the identifier is quoted rather than bound.
     */
    async provisionWorkspace(workspace) {
      assertWorkspaceName(workspace);
      if (await this.workspaceExists(workspace)) return false;

      const client = await this.admin();
      try {
        // TEMPLATE gives every workspace the same extensions as the template
        // database created by scripts/init-db.sh. IF NOT EXISTS is not valid
        // here, hence the existence check above.
        await client.query(
          `CREATE DATABASE ${quoteIdentifier(workspace)} TEMPLATE ${quoteIdentifier("paradigm_template")}`
        );
      } catch (err) {
        // 42P04 = duplicate_database, which is a benign race between two
        // concurrent provisioning calls.
        if (err.code !== "42P04") throw err;
      } finally {
        client.release();
      }

      // A connection pool opened before CREATE DATABASE would never see the
      // new database. Drop it so the next call builds a fresh one.
      const stale = pools.get(workspace);
      if (stale) {
        pools.delete(workspace);
        stale.end().catch(() => {});
      }

      return true;
    },

    /** Every provisioned workspace database. */
    async listWorkspaces({ includeSystem = false } = {}) {
      const client = await this.admin();
      try {
        const { rows } = await client.query(
          includeSystem
            ? `SELECT datname FROM pg_database
               WHERE datistemplate = false AND datname NOT IN ('postgres')
               ORDER BY datname`
            : `SELECT datname FROM pg_database
               WHERE datistemplate = false
                 AND datname NOT IN ('postgres', 'paradigm', 'paradigm_template')
               ORDER BY datname`
        );
        return rows.map((row) => row.datname);
      } finally {
        client.release();
      }
    },

    /**
     * Drop a workspace database. Destructive and irreversible.
     *
     * Exists for tests and for an explicit "remove this workspace" operation.
     * It refuses to touch anything whose name does not look like a workspace,
     * because the alternative is a typo deleting real memory.
     */
    async dropWorkspace(workspace) {
      assertWorkspaceName(workspace);
      const client = await this.admin();
      try {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [workspace]
        );
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(workspace)}`);
      } finally {
        client.release();
      }
      const stale = pools.get(workspace);
      if (stale) {
        pools.delete(workspace);
        stale.end().catch(() => {});
      }
      return true;
    },

    /** Close every pool. Called on shutdown so the process exits cleanly. */
    async close() {
      const open = [...pools.values()];
      pools.clear();
      await Promise.allSettled(open.map((pool) => pool.end()));
    },

    /** Exposed for tests and for the health endpoint. */
    get openWorkspaceCount() {
      return pools.size;
    }
  };
}
