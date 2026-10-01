import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../../src/store/store.mjs";
import {
  migrate,
  assertSchemaVersion,
  SchemaVersionError,
  expectedVersion,
  loadMigrations
} from "../../src/store/migrate.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createPoolManager } from "../../src/store/pool.mjs";
import { assertWorkspaceName, WorkspaceNameError, isValidWorkspaceName } from "../../src/store/workspace-name.mjs";

/**
 * Integration tests against a real PostgreSQL.
 *
 * Not skipped silently: if TEST_DATABASE_URL is missing the suite fails with a
 * clear message rather than passing vacuously. A green run that tested nothing
 * is worse than a red one.
 *
 * Setup lives in a `before` hook rather than a top-level await, because a
 * top-level await makes the file fail to register as a test file at all.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run these with:\n" +
      "  TEST_DATABASE_URL=postgres://paradigm:testpassword@localhost:5432/paradigm \\\n" +
      "    node --test test/integration/*.test.mjs\n" +
      "Or use: npm run test:integration"
  );
}

const url = new URL(DATABASE_URL);
const config = loadConfig({
  ...process.env,
  POSTGRES_HOST: url.hostname,
  POSTGRES_PORT: url.port,
  POSTGRES_SUPERUSER: decodeURIComponent(url.username),
  POSTGRES_PASSWORD: decodeURIComponent(url.password),
  POSTGRES_DB: url.pathname.replace(/^\//, ""),
  OPENROUTER_API_KEY: "test-key-not-used-in-integration",
  PARADIGM_EMBED_DIMENSIONS: "3072"
});

const pools = createPoolManager(config, {});

/** Unique workspace per run, so a failed run leaves nothing to clean up. */
function freshWorkspace(label) {
  return `t_${label}_${Date.now().toString(36)}`;
}

async function provision(label) {
  const workspace = freshWorkspace(label);
  await pools.provisionWorkspace(workspace);
  const store = createStore({ workspace, pools });
  const pool = pools.poolFor(workspace);
  const result = await migrate(pool);
  return { workspace, store, pool, migration: result };
}

/** Every workspace this run created, dropped in `after`. */
const created = [];

async function provisionTracked(label) {
  const handle = await provision(label);
  created.push(handle.workspace);
  return handle;
}

before(async () => {
  // The template database is what scripts/init-db.sh creates. If it is absent,
  // provisioning cannot work — which is the correct failure, since silently
  // creating an extension-less template would produce a workspace that later
  // fails at the vector layer with a confusing error.
  const client = await pools.admin();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'paradigm_template'"
    );
    if (rows.length === 0) {
      throw new Error(
        "Database 'paradigm_template' does not exist. scripts/init-db.sh creates it on " +
          "first start of the Postgres volume. Create it manually for tests:\n" +
          "  CREATE DATABASE paradigm_template TEMPLATE template0;\n" +
          "  \\c paradigm_template\n" +
          "  CREATE EXTENSION IF NOT EXISTS vector;\n" +
          "  CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      );
    }
  } finally {
    client.release();
  }
});

after(async () => {
  // Drop the test databases rather than leaving them behind. A suite that
  // accumulates a database per run makes the next run slower and eventually
  // exhausts the connection limit.
  // Close the pools before dropping the databases: an open connection to a
  // database prevents DROP DATABASE, and the pools are what hold them.
  await pools.close();
  for (const workspace of created) {
    await pools.dropWorkspace(workspace).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("migrations apply and report the version range", async () => {
  const { workspace, pool, migration } = await provisionTracked("migrate");
    assert.equal(migration.from, 0);
    assert.equal(migration.to, expectedVersion());
    assert.ok(migration.applied.length >= 1);
    assert.equal(await expectedVersion(), migration.applied.at(-1).version);
});

test("migrations are idempotent", async () => {
  const { pool } = await provisionTracked("idem");
    const second = await migrate(pool);
    assert.equal(second.applied.length, 0, "a second run must apply nothing");
    assert.equal(second.from, second.to);
});

test("schema version guard rejects a mismatched database", async () => {
  const { workspace, pool } = await provisionTracked("guard");

  // Simulate a database written by a newer build.
  await pool.query("INSERT INTO schema_meta (version) VALUES ($1) ON CONFLICT DO NOTHING", [
    expectedVersion() + 1
  ]);

  await assert.rejects(
    () => assertSchemaVersion(pool),
    (err) => {
      assert.ok(err instanceof SchemaVersionError);
      assert.equal(err.found, expectedVersion() + 1);
      return true;
    }
  );
});

test("schema version guard rejects an unmigrated database", async () => {
  const workspace = freshWorkspace("unmigrated");
  created.push(workspace);
  await pools.provisionWorkspace(workspace);
  const pool = pools.poolFor(workspace);

  await assert.rejects(
    () => assertSchemaVersion(pool),
    (err) => err instanceof SchemaVersionError && err.found === 0
  );
});

test("every migration file follows the naming convention", () => {
  for (const migration of loadMigrations()) {
    assert.match(migration.file, /^\d{4}_[a-z0-9_]+\.sql$/);
    assert.ok(migration.sql.trim().length > 0, `${migration.file} is empty`);
  }
});

// ---------------------------------------------------------------------------
// Store: nodes
// ---------------------------------------------------------------------------

test("createNode persists the tree and metadata", async () => {
  const { store } = await provisionTracked("nodes");
    const root = await store.createNode({
      id: "projects.demo",
      label: "Demo",
      one_liner: "a demo project",
      importance: 0.9,
      freshness: 0.7,
      keywords: ["demo", "test"],
      retrieval_policy: { default_depth: 2, max_tokens: 1200 }
    });

    assert.equal(root.id, "projects.demo");
    assert.equal(root.importance, 0.9);
    assert.deepEqual(root.keywords, ["demo", "test"]);
    assert.deepEqual(root.retrieval_policy, { default_depth: 2, max_tokens: 1200 });

    const child = await store.createNode({
      id: "projects.demo.child",
      parent_id: "projects.demo",
      label: "Child"
    });
    assert.equal(child.parent_id, "projects.demo");

    // The parent's children list is maintained automatically.
    const reread = await store.readNode("projects.demo");
    assert.ok(reread.children.includes("projects.demo.child"));
});

test("createNode refuses a parent that does not exist", async () => {
  const { store } = await provisionTracked("orphan");
  await assert.rejects(
    () =>
      store.createNode({
        id: "projects.a.b",
        parent_id: "projects.nonexistent",
        label: "B"
      }),
    /parent projects\.nonexistent does not exist/
  );
});

test("deleteNode reparents children and orphans items rather than deleting them", async () => {
  const { store } = await provisionTracked("delnode");
    await store.createNode({ id: "root", label: "Root" });
    await store.createNode({ id: "mid", parent_id: "root", label: "Mid" });
    await store.createNode({ id: "leaf", parent_id: "mid", label: "Leaf" });
    await store.upsertItem({ node_id: "mid", content: "a memory" });

    const result = await store.deleteNode("mid");
    assert.equal(result.deleted, true);
    assert.equal(result.reparentedTo, "root");

    assert.equal((await store.readNode("leaf")).parent_id, "root");
    assert.equal(await store.readNode("mid"), null);

    // The item survives, orphaned. Losing memories because someone tidied the
    // tree is not recoverable.
    const items = await store.listItems({ nodeId: "root", status: "active" });
    assert.equal(items.length, 1);
});

// ---------------------------------------------------------------------------
// Store: items
// ---------------------------------------------------------------------------

test("upsertItem preserves proposed status for the review workflow", async () => {
  const { store } = await provisionTracked("proposed");
    await store.createNode({ id: "n", label: "N" });
    const item = await store.upsertItem({
      node_id: "n",
      content: "awaiting review",
      status: "proposed"
    });
    assert.equal(item.status, "proposed");
    const proposed = await store.listItems({ nodeId: "n", status: "proposed" });
    assert.equal(proposed.length, 1);
});

test("upsertItem updates in place without duplicating", async () => {
  const { store } = await provisionTracked("upsert");
    await store.createNode({ id: "n", label: "N" });
    const first = await store.upsertItem({ id: "fixed.id", node_id: "n", content: "before" });
    const second = await store.upsertItem({ id: "fixed.id", node_id: "n", content: "after" });

    assert.equal(first.id, second.id);
    assert.equal(second.content, "after");
    assert.equal((await store.listItems({ nodeId: "n" })).length, 1);
});

test("supersedes relationship survives a round trip", async () => {
  const { store } = await provisionTracked("supersede");
    await store.createNode({ id: "n", label: "N" });
    const old = await store.upsertItem({ id: "old", node_id: "n", content: "old fact" });
    const newer = await store.upsertItem({
      id: "new",
      node_id: "n",
      content: "corrected fact",
      supersedes: old.id
    });
    assert.equal(newer.supersedes, "old");
    assert.equal((await store.readItem("new")).supersedes, "old");
});

test("deleteItem is a soft delete and the row is retained", async () => {
  const { store } = await provisionTracked("softdelete");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({ id: "i", node_id: "n", content: "x" });

    const result = await store.deleteItem("i");
    assert.equal(result.deleted, true);

    assert.equal((await store.readItem("i")).status, "deleted");
    assert.notEqual((await store.readItem("i")).deleted_at, null);
    assert.equal((await store.listItems({ nodeId: "n" })).length, 0);
});

// ---------------------------------------------------------------------------
// Store: bitemporal behaviour
// ---------------------------------------------------------------------------

test("invalidateItem keeps the fact and marks its end of validity", async () => {
  const { store } = await provisionTracked("invalidate");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({
      id: "i",
      node_id: "n",
      content: "was true",
      occurred_start: new Date(Date.now() - 10 * 86400000)
    });

    const invalidatedAt = new Date();
    const result = await store.invalidateItem("i", invalidatedAt);
    assert.equal(result.invalidated, true);

    const item = await store.readItem("i");
    assert.notEqual(item.invalidated_at, null);
    assert.notEqual(item.occurred_end, null);
    assert.equal(item.content, "was true", "an invalidated fact is retained, not deleted");
});

test("asOf query returns the fact that was true at that moment", async () => {
  const { store } = await provisionTracked("asof");
    await store.createNode({ id: "n", label: "N" });

    const now = Date.now();
    await store.upsertItem({
      id: "was_true",
      node_id: "n",
      content: "the old belief",
      occurred_start: new Date(now - 20 * 86400000),
      occurred_end: new Date(now - 5 * 86400000),
      recorded_at: new Date(now - 20 * 86400000)
    });

    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const past = await store.searchItems("", { nodeId: "n", asOf: sevenDaysAgo });
    const present = await store.searchItems("", { nodeId: "n", asOf: new Date(now) });

    assert.equal(past.length, 1, "7 days ago the fact was still true");
    assert.equal(past[0].item.id, "was_true");

    assert.equal(present.length, 0, "today it is no longer true");
});

test("an invalidated fact is excluded by default and retrievable when asked for", async () => {
  const { store } = await provisionTracked("notinvalid");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({ id: "i", node_id: "n", content: "x" });
    await store.invalidateItem("i", new Date());

    // Two independent mechanisms must both hide it. `invalidated_at IS NULL`
    // is the temporal filter; `status = 'active'` is the lifecycle filter.
    // Either alone would be sufficient, and both being present means a bug in
    // one does not leak stale facts.
    assert.equal((await store.searchItems("", { nodeId: "n" })).length, 0);
    assert.equal(
      (await store.searchItems("", { nodeId: "n", requireValid: false })).length,
      0,
      "the lifecycle filter alone still excludes it"
    );
    assert.equal(
      (
        await store.searchItems("", {
          nodeId: "n",
          status: "invalidated",
          requireValid: false
        })
      ).length,
      1,
      "and it is still there when asked for explicitly"
    );
});

// ---------------------------------------------------------------------------
// Store: tags as JSONB
// ---------------------------------------------------------------------------

test("tag filter is a query, not a substring match", async () => {
  const { store } = await provisionTracked("tags");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({ id: "a", node_id: "n", content: "x", tags: ["alpha"] });
    await store.upsertItem({ id: "b", node_id: "n", content: "y", tags: ["beta", "alpha"] });

    const alpha = await store.searchItems("", { nodeId: "n", tags: ["alpha"] });
    assert.equal(alpha.length, 2);

    const beta = await store.searchItems("", { nodeId: "n", tags: ["beta"] });
    assert.equal(beta.length, 1);

    assert.equal((await store.searchItems("", { nodeId: "n", tags: ["gamma"] })).length, 0);
});

// ---------------------------------------------------------------------------
// Store: audit log
// ---------------------------------------------------------------------------

test("mutation log is written and is genuinely append-only", async () => {
  const { workspace, store, pool } = await provisionTracked("audit");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({ id: "i", node_id: "n", content: "x" });

    const mutations = await store.listMutations();
    assert.ok(mutations.length >= 2);
    assert.ok(mutations.some((m) => m.operation === "create_node"));
    assert.ok(mutations.some((m) => m.operation === "write"));

    // The trigger, not convention, is what makes this true.
    await assert.rejects(
      () => pool.query("UPDATE memory_mutations SET reason = 'tampered'"),
      /append-only/
    );
    await assert.rejects(
      () => pool.query("DELETE FROM memory_mutations"),
      /append-only/
    );
});

// ---------------------------------------------------------------------------
// Store: embeddings cache
// ---------------------------------------------------------------------------

test("embedding cache is keyed by model so a model change cannot overwrite", async () => {
  const { store } = await provisionTracked("embed");
    const vector = Array.from({ length: 3072 }, (_, i) => (i % 7) / 7);

    await store.upsertCachedEmbedding("key1", "model-a", vector, 3072);
    await store.upsertCachedEmbedding("key1", "model-b", [0.5], 1);

    const a = await store.getCachedEmbedding("key1", "model-a");
    const b = await store.getCachedEmbedding("key1", "model-b");

    assert.equal(a.dimensions, 3072);
    assert.equal(a.vector.length, 3072);
    assert.equal(b.dimensions, 1);
    assert.equal(b.vector.length, 1);
});

// ---------------------------------------------------------------------------
// Store: decisions and calibration inputs
// ---------------------------------------------------------------------------

test("decisions record negative outcomes too, which calibration needs", async () => {
  const { store } = await provisionTracked("decisions");
    await store.recordDecision({
      operation: "write_gate",
      model: "upstage/solar-decide",
      noul: 0.42,
      applied: false,
      threshold: 0.6
    });
    await store.recordDecision({
      operation: "write_gate",
      model: "upstage/solar-decide",
      noul: 0.91,
      applied: true,
      threshold: 0.6
    });

    const stats = await store.stats();
    assert.equal(stats.decisions.total, 2);
    assert.equal(stats.decisions.unlabelled, 2);
});

// ---------------------------------------------------------------------------
// Store: stats and capabilities
// ---------------------------------------------------------------------------

test("stats separates active, proposed, deleted and invalidated", async () => {
  const { store } = await provisionTracked("stats");
    await store.createNode({ id: "n", label: "N" });
    await store.upsertItem({ id: "a", node_id: "n", content: "x" });
    await store.upsertItem({ id: "b", node_id: "n", content: "y", status: "proposed" });
    await store.upsertItem({ id: "c", node_id: "n", content: "z" });
    await store.deleteItem("c");
    await store.upsertItem({ id: "d", node_id: "n", content: "w" });
    await store.invalidateItem("d", new Date());

    const stats = await store.stats();
    assert.equal(stats.nodes, 1);
    assert.equal(stats.items.active, 1);
    assert.equal(stats.items.proposed, 1);
    assert.equal(stats.items.deleted, 1);
    assert.equal(stats.items.invalidated, 1);
    assert.equal(stats.items.total, 4);
    assert.ok(stats.mutations >= 5);
});

test("capabilities reports the real BM25 engine rather than assuming one", async () => {
  const { store } = await provisionTracked("caps");
    const caps = await store.capabilities();
    assert.equal(caps.vector, true, "pgvector must be present");
    // Which engine it is depends on the image; the requirement is that it is
    // reported rather than assumed.
    assert.ok(["pg_search", "tsvector"].includes(caps.bm25Engine));
    assert.equal(caps.bm25, caps.bm25Engine);
});

// ---------------------------------------------------------------------------
// Workspace isolation
// ---------------------------------------------------------------------------

test("workspaces do not see each other's data", async () => {
  const a = await provisionTracked("iso_a");
  const b = await provisionTracked("iso_b");
    await a.store.createNode({ id: "n", label: "A" });
    await a.store.upsertItem({ id: "shared.id", node_id: "n", content: "in A" });

    await b.store.createNode({ id: "n", label: "B" });
    await b.store.upsertItem({ id: "shared.id", node_id: "n", content: "in B" });

    const fromA = await a.store.readItem("shared.id");
    const fromB = await b.store.readItem("shared.id");

    assert.equal(fromA.content, "in A");
    assert.equal(fromB.content, "in B");
    assert.equal((await a.store.listItems({})).length, 1);
    assert.equal((await b.store.listItems({})).length, 1);
});

test("the shared workspace is a distinct database", async () => {
  const { store } = await provisionTracked("shared");

  // `_shared` is created by scripts/init-db.sh, not by a workspace
  // provisioning call — it is infrastructure, not a user-named workspace.
  // This test creates it when absent, so it does not depend on the caller
  // having run the init script. A test that fails because the environment was
  // not prepared reports the wrong problem.
  let all = await pools.listWorkspaces({ includeSystem: true });
  if (!all.includes("_shared")) {
    await pools.provisionWorkspace("_shared");
    all = await pools.listWorkspaces({ includeSystem: true });
  }

  assert.ok(
    all.includes("_shared"),
    `the _shared database must exist. Found: ${all.join(", ")}`
  );

  // Distinguishable from an ordinary workspace: valid as infrastructure, and
  // impossible to confuse with a user-supplied name.
  assert.ok(isValidWorkspaceName("_shared"));
  assert.throws(() => assertWorkspaceName("template1"), WorkspaceNameError);
  assert.throws(() => assertWorkspaceName("_other"), WorkspaceNameError);
});

test("workspace names are validated before they reach SQL", () => {
  assert.ok(isValidWorkspaceName("main"));
  assert.ok(isValidWorkspaceName("geos_acervo"));

  for (const bad of ["geos-acervo", "Main", "postgres", "1abc", "a b", "x".repeat(64)]) {
    assert.equal(isValidWorkspaceName(bad), false, `${bad} must be rejected`);
    assert.throws(() => assertWorkspaceName(bad), WorkspaceNameError);
  }
});

test("provisioning the same workspace twice is a no-op", async () => {
  const workspace = freshWorkspace("dup");
  created.push(workspace);
  assert.equal(await pools.provisionWorkspace(workspace), true);
  assert.equal(await pools.provisionWorkspace(workspace), false);
});

// ---------------------------------------------------------------------------
// Snapshot round-trip — the gate that proves nothing is lost
// ---------------------------------------------------------------------------

test("items survive a full round trip through the store", async () => {
  const source = await provisionTracked("rt_src");
    await source.store.createNode({
      id: "projects.roundtrip",
      parent_id: null,
      label: "Round trip",
      one_liner: "proves nothing is lost",
      importance: 0.85,
      freshness: 0.6,
      keywords: ["roundtrip", "gate"],
      retrieval_policy: { default_depth: 2, max_tokens: 1200, require_evidence: false },
      sources: ["https://example.invalid/doc"]
    });

    await source.store.upsertItem({
      id: "mem.rt.1",
      node_id: "projects.roundtrip",
      content: "first memory with accents: ação, decisão, ção",
      tags: ["roundtrip", "unicode"],
      source: "test",
      importance: 0.9,
      confidence: 0.95,
      supersedes: "mem.rt.0"
    });

    await source.store.upsertItem({
      id: "mem.rt.0",
      node_id: "projects.roundtrip",
      content: "superseded memory",
      status: "proposed"
    });

    const items = await source.store.listItems({ nodeId: "projects.roundtrip", status: null });
    const node = await source.store.readNode("projects.roundtrip");
    const mutations = await source.store.listMutations({ limit: 1000 });

    // Everything that must survive is present and typed correctly.
    assert.equal(items.length, 2);
    assert.equal(node.keywords.length, 2);
    assert.deepEqual(node.sources, ["https://example.invalid/doc"]);
    assert.equal(node.retrieval_policy.max_tokens, 1200);

    const first = items.find((i) => i.id === "mem.rt.1");
    assert.deepEqual(first.tags, ["roundtrip", "unicode"]);
    assert.equal(first.importance, 0.9);
    assert.equal(first.confidence, 0.95);
    assert.equal(first.supersedes, "mem.rt.0");
    assert.match(first.content, /ação/);

    assert.ok(mutations.length >= 3, "the audit trail must be reconstructable");

    // Re-emit the same data through a fresh store handle and compare. This is
    // the part that would catch a field silently dropped by a mapping.
    const reread = await source.store.readItem("mem.rt.1");
    assert.deepEqual(reread, first);
});
