import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration runner.
 *
 * Migrations are plain SQL files named `NNNN_name.sql`, applied in order. Each
 * one runs inside a transaction, so a failure leaves the schema at the last
 * good version rather than half-applied.
 *
 * The version guard is the important part: the server refuses to start against
 * a database whose schema version it does not recognise. That turns "someone
 * restored a backup into a newer schema" or "someone ran the new code against
 * an old database" from a confusing runtime error into a clear startup failure.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, "migrations");

export class SchemaVersionError extends Error {
  constructor(found, expected) {
    const higher = found > expected;
    super(
      `Database schema version is ${found}, this build expects ${expected}. ` +
        (higher
          ? `The database is NEWER than the code — this usually means an older build ` +
            `was deployed against a newer schema. Restore a matching backup or upgrade.`
          : `The database is OLDER than the code — migrations have not been run. ` +
            `Run: npm run migrate`)
    );
    this.name = "SchemaVersionError";
    this.found = found;
    this.expected = expected;
  }
}

/** Read the migration files and order them by their numeric prefix. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  return entries
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = name.match(/^(\d{4})_([a-z0-9_]+)\.sql$/);
      if (!match) {
        throw new Error(
          `Migration ${name} does not follow NNNN_name.sql. A rename would ` +
            `break the ordering, which is why the convention is enforced.`
        );
      }
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        file: name,
        path: join(dir, name),
        sql: readFileSync(join(dir, name), "utf8")
      };
    })
    .sort((a, b) => a.version - b.version);
}

/** The highest migration version in this build. */
export function expectedVersion(dir = MIGRATIONS_DIR) {
  const migrations = loadMigrations(dir);
  if (migrations.length === 0) return 0;
  return migrations[migrations.length - 1].version;
}

/** Current version recorded in a database. Returns 0 when never migrated. */
export async function currentVersion(pool) {
  const { rows } = await pool.query(
    `SELECT to_regclass('public.schema_meta') IS NOT NULL AS exists`
  );
  if (!rows[0].exists) return 0;

  const result = await pool.query(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta"
  );
  return Number(result.rows[0].version);
}

/**
 * Apply pending migrations to one workspace database.
 *
 * Advisory lock: two processes starting at once would otherwise both see
 * version N and both try to apply N+1. The second one blocks on the lock, then
 * sees the version has moved and does nothing.
 */
export async function migrate(client, { dir = MIGRATIONS_DIR, logger = null } = {}) {
  const migrations = loadMigrations(dir);

  // 4242422 is an arbitrary but stable lock id. Any constant works; what
  // matters is that it is the same across processes.
  await client.query("SELECT pg_advisory_lock(4242422)");
  try {
    const from = await currentVersion(client);
    const applied = [];

    for (const migration of migrations) {
      if (migration.version <= from) continue;

      // One transaction per migration. A failure rolls back that migration and
      // nothing else, so the schema stays at a version that exists.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_meta (version) VALUES ($1) ON CONFLICT DO NOTHING",
          [migration.version]
        );
        await client.query("COMMIT");
        applied.push(migration);
        logger?.info("migration applied", {
          version: migration.version,
          name: migration.name
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${migration.file} failed and was rolled back. ` +
            `The schema is still at version ${from}. Cause: ${err.message}`,
          { cause: err }
        );
      }
    }

    return { from, to: expectedVersion(dir), applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock(4242422)");
  }
}

/**
 * Verify a database is at exactly the version this build expects.
 *
 * Called on startup. A mismatch is a refusal to start, not a warning.
 */
export async function assertSchemaVersion(client, { dir = MIGRATIONS_DIR } = {}) {
  const expected = expectedVersion(dir);
  const found = await currentVersion(client);
  if (found !== expected) {
    throw new SchemaVersionError(found, expected);
  }
  return found;
}

/**
 * Record the embedding model the database was built for.
 *
 * This is what makes a model change a loud failure instead of silently wrong
 * results: vectors from two models do not share a space, and comparing them
 * returns plausible-looking nonsense rather than an error.
 */
export async function recordEmbeddingModel(client, model, dimensions) {
  await client.query(
    "UPDATE schema_meta SET embedding_model = $1, embed_dimensions = $2",
    [model, dimensions]
  );
  const { rows } = await client.query(
    "SELECT embedding_model, embed_dimensions FROM schema_meta LIMIT 1"
  );
  return rows[0];
}

export async function readEmbeddingModel(client) {
  const { rows } = await client.query(
    "SELECT embedding_model, embed_dimensions FROM schema_meta ORDER BY version LIMIT 1"
  );
  return rows[0] ?? { embedding_model: null, embed_dimensions: null };
}

/** CLI entry point: `npm run migrate`. */
async function main() {
  const { loadConfig } = await import("../config.mjs");
  const { createLogger } = await import("../logger.mjs");
  const { createPoolManager } = await import("./pool.mjs");
  const { listWorkspaces } = await import("./workspace-name.mjs");

  void listWorkspaces;

  const config = loadConfig();
  const logger = createLogger({ level: config.server.logLevel });
  const pools = createPoolManager(config, { logger });

  const workspaces = await pools.listWorkspaces();
  if (workspaces.length === 0) {
    logger.warn("no workspace databases found — provision one first");
  }

  for (const workspace of workspaces) {
    const pool = pools.poolFor(workspace);
    const result = await migrate(pool, { logger });
    logger.info("migrations complete", {
      workspace,
      from: result.from,
      to: result.to,
      applied: result.applied.map((m) => m.file)
    });
  }

  await pools.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
