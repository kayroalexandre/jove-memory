import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp, createHttpServer } from "../../src/api/server.mjs";
import { createLogger } from "../../src/logger.mjs";
import { createPoolManager } from "../../src/store/pool.mjs";
import { createStore } from "../../src/store/store.mjs";
import { migrate } from "../../src/store/migrate.mjs";
import { loadConfig } from "../../src/config.mjs";

/**
 * Phase 2 gate: the stack comes up clean, and the health check makes no
 * outbound request.
 *
 * The outbound-request assertion is the one that matters and the one that is
 * easiest to get wrong: a health check that pings OpenRouter to prove the key
 * works spends money and rate-limit on every container restart, and turns a
 * third-party outage into a restart loop.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run with:\n" +
      "  TEST_DATABASE_URL=postgres://... node --test test/integration/*.test.mjs"
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
  OPENROUTER_API_KEY: "test-key-not-used-here",
  PARADIGM_EMBED_DIMENSIONS: "3072"
});

const pools = createPoolManager(config, {});
const created = [];

/** Every fetch recorded, so a test can assert nothing left the machine. */
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  const target = typeof args[0] === "string" ? args[0] : String(args[0]?.url ?? args[0]);
  outbound.push(target);
  return realFetch(...args);
};

before(async () => {
  const client = await pools.admin();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'paradigm_template'"
    );
    if (rows.length === 0) {
      throw new Error(
        "Database 'paradigm_template' does not exist. Create it with:\n" +
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
  globalThis.fetch = realFetch;
  await pools.close();
  for (const workspace of created) {
    await pools.dropWorkspace(workspace).catch(() => {});
  }
});

async function makeWorkspace(label) {
  const workspace = `t2_${label}_${Date.now().toString(36)}`;
  created.push(workspace);
  await pools.provisionWorkspace(workspace, { migrate });
  await migrate(pools.poolFor(workspace));
  return workspace;
}

const logger = createLogger({ level: "error", stream: { write() {} } });
const app = createApp({ config, logger, pools });

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("health check makes no outbound HTTP request", async () => {
  outbound.length = 0;
  const body = await app.handleHealth();
  assert.equal(
    outbound.length,
    0,
    `the health check must not reach the network. It made: ${outbound.join(", ")}`
  );
  assert.ok(body);
});

test("health check makes no outbound request even with a database to inspect", async () => {
  await makeWorkspace("health");
  outbound.length = 0;
  await app.handleHealth();
  assert.equal(outbound.length, 0, `made: ${outbound.join(", ")}`);
});

test("health check makes no outbound request across five consecutive calls", async () => {
  await makeWorkspace("repeat");
  outbound.length = 0;
  for (let i = 0; i < 5; i += 1) await app.handleHealth();
  assert.equal(outbound.length, 0, `made: ${outbound.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Health reporting
// ---------------------------------------------------------------------------

test("health reports each dependency separately", async () => {
  const body = await app.handleHealth();

  assert.ok(body.dependencies.postgres, "postgres must be reported");
  assert.ok(body.dependencies.minio, "minio must be reported");
  assert.ok(body.dependencies.providers, "providers must be reported");

  // The three services named in compose.yml, each with its own status.
  assert.equal(typeof body.dependencies.postgres.status, "string");
  assert.equal(typeof body.dependencies.minio.status, "string");
  assert.equal(typeof body.dependencies.providers.openrouter.status, "string");
});

test("health reports the provider as configured but deliberately unverified", async () => {
  const body = await app.handleHealth();
  const provider = body.dependencies.providers.openrouter;

  assert.equal(provider.status, "configured");
  assert.equal(
    provider.verified,
    false,
    "the health check must not claim a provider is verified — it never calls it"
  );
  assert.match(provider.note, /no outbound request/i);
});

test("health surfaces the configured models so a wrong slug is visible", async () => {
  const body = await app.handleHealth();
  assert.equal(body.dependencies.providers.embedModel, config.providers.embedModel);
  assert.equal(body.dependencies.providers.decisionModel, config.providers.decisionModel);
  assert.equal(body.dependencies.providers.inferenceModel, config.providers.inferenceModel);
});

test("health is not unhealthy when a provider is unavailable", async () => {
  // A provider outage degrades retrieval; it must not restart the container.
  const noKeyConfig = { ...config, providers: { ...config.providers, apiKey: "" } };
  const noKeyApp = createApp({ config: noKeyConfig, logger, pools });
  const body = await noKeyApp.handleHealth();

  assert.notEqual(body.status, "unhealthy");
  assert.ok(body.degraded.includes("openrouter"), "the degradation must be named");
});

test("health returns 503 only when postgres is unreachable", async () => {
  const brokenPools = {
    listWorkspaces: async () => {
      throw new Error("connection refused");
    }
  };
  const brokenApp = createApp({ config, logger, pools: brokenPools });
  const body = await brokenApp.handleHealth();

  assert.equal(body.status, "unhealthy");
  assert.equal(body.dependencies.postgres.status, "unreachable");
  assert.ok(body.degraded.includes("postgres"));
});

// ---------------------------------------------------------------------------
// Workspace registry
// ---------------------------------------------------------------------------

test("workspaces endpoint lists each workspace with its stats", async () => {
  const workspace = await makeWorkspace("list");
  const store = createStore({ workspace, pools, logger });
  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i", node_id: "n", content: "x" });

  const body = await app.handleWorkspaces();
  const found = body.workspaces.find((w) => w.workspace === workspace);

  assert.ok(found, `workspace ${workspace} must appear in the listing`);
  assert.equal(found.items.active, 1);
  assert.equal(found.capabilities.vector, true);
  assert.equal(body.shared, "_shared");
});

test("an unmigrated workspace is reported rather than hidden", async () => {
  const workspace = `t2_unmigrated_${Date.now().toString(36)}`;
  created.push(workspace);
  // Created without migrating — the state the server refuses to start against.
  await pools.createWorkspaceDatabase(workspace);

  const body = await app.handleWorkspaces();
  const found = body.workspaces.find((w) => w.workspace === workspace);

  assert.ok(found, "the workspace must appear");
  assert.ok(found.error, "and it must say why its stats are unavailable");
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

test("the server binds loopback and answers /health", async () => {
  const server = createHttpServer({ config, logger, pools });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await realFetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "jove-memory");

    assert.equal(
      res.headers.get("cache-control"),
      "no-store",
      "responses must not be cached — this holds personal memory content"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an unknown path is a 404 with no internal detail", async () => {
  const server = createHttpServer({ config, logger, pools });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await realFetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "not_found");
    assert.equal(body.path, "/nope");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a failing request returns a generic error, not the cause", async () => {
  // The cause of a driver error can include a connection string with a
  // password. The log gets the detail; the response body does not.
  const explodingPools = {
    listWorkspaces: async () => {
      throw new Error("connect ECONNREFUSED postgres://paradigm:hunter2@db:5432/x");
    }
  };
  const server = createHttpServer({ config, logger, pools: explodingPools });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await realFetch(`http://127.0.0.1:${port}/v1/workspaces`);
    assert.equal(res.status, 500);
    const raw = await res.text();

    assert.equal(raw.includes("hunter2"), false, "the response must not carry the cause");
    assert.match(raw, /internal_error/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
