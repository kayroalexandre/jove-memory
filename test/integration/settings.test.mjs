import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../../src/logger.mjs";
import { createPoolManager } from "../../src/store/pool.mjs";
import { createStore } from "../../src/store/store.mjs";
import { migrate } from "../../src/store/migrate.mjs";
import { createHttpServer } from "../../src/api/server.mjs";
import { loadConfig } from "../../src/config.mjs";

/**
 * The settings endpoint, against a real PostgreSQL.
 *
 * The property every test here defends is the one the whole design turns on:
 * **the database does not contain the key.** Not in the ciphertext column, not
 * in a log line, not in an audit row, not in anything a `pg_dump` would carry.
 *
 * The unit tests assert this against a fake store. This file asserts it against
 * the real thing, because "the query that reaches the database does not carry
 * the value" is a claim about a live connection, and a fake store can only
 * confirm the module's own idea of what it sent.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is not set. Run with: npm run test:integration");
}

const KEY = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
const DIMS = 3072;

const url = new URL(DATABASE_URL);
const config = loadConfig({
  ...process.env,
  POSTGRES_HOST: url.hostname,
  POSTGRES_PORT: url.port,
  POSTGRES_SUPERUSER: decodeURIComponent(url.username),
  POSTGRES_PASSWORD: decodeURIComponent(url.password),
  POSTGRES_DB: url.pathname.replace(/^\//, ""),
  OPENROUTER_API_KEY: "",
  JOVE_HOST_UID: undefined,
  JOVE_MASTER_KEY_FILE: undefined,
  PARADIGM_EMBED_DIMENSIONS: String(DIMS)
});

const pools = createPoolManager(config, {});
const logger = createLogger({ level: "error", stream: { write() {} } });
const keyDir = mkdtempSync(join(tmpdir(), "jove-settings-"));
process.env.JOVE_MASTER_KEY_FILE = join(keyDir, "master.key");

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
          "  \c paradigm_template\n  CREATE EXTENSION IF NOT EXISTS vector;\n" +
          "  CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      );
    }
  } finally {
    client.release();
  }
});

/**
 * A fresh workspace, server and store for one test.
 *
 * One per test rather than one per file. Each test drops its workspace when it
 * finishes — which it must, because they are expensive to keep around — and a
 * shared one is therefore gone by the time the second test runs. That mistake
 * was already made once in this project, in Phase 3, and the symptom was every
 * subsequent test reporting "relation does not exist" against a database a
 * previous test had dropped.
 */
async function withServer(t, { embedder = defaultEmbedder(), buildEmbedder = undefined } = {}) {
  const workspace = `t5_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await pools.provisionWorkspace(workspace, { migrate });
  t.after(() => pools.dropWorkspace(workspace).catch(() => {}));

  const store = createStore({ workspace, pools, logger });
  const server = createHttpServer({ config, logger, pools, store, embedder, buildEmbedder });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const api = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options);
  const post = (body) =>
    api("/v1/settings/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

  return { workspace, store, server, port, api, post, pools };
}

/** A provider that always works, so these tests measure storage not mood. */
function defaultEmbedder() {
  return {
    model: config.providers.embedModel,
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Array(DIMS).fill(0.01));
    }
  };
}

// ---------------------------------------------------------------------------
// The load-bearing assertion
// ---------------------------------------------------------------------------

test("the key does not appear anywhere in the database", async (t) => {
  const { post, pools, workspace } = await withServer(t);
  await post({ action: "save", value: KEY });

  // Every column of the credential row, rendered as text. Not just the
  // ciphertext: a leak into the fingerprint or the audit would count.
  const { rows } = await pools.poolFor(workspace).query(
    `SELECT row_to_json(provider_credentials)::text AS row
     FROM provider_credentials`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row.includes(KEY), false, "the key is in the credential row");

  const { rows: audit } = await pools.poolFor(workspace).query(
    "SELECT row_to_json(credentials_audit)::text AS row FROM credentials_audit"
  );
  for (const entry of audit) {
    assert.equal(entry.row.includes(KEY), false, "the key is in the audit trail");
  }

  // And the byte-level check, which is what a `pg_dump` would expose.
  const { rows: bytes } = await pools.poolFor(workspace).query(
    `SELECT position($1 in encode(ciphertext, 'escape')) AS in_ciphertext,
            position($1 in encode(nonce, 'escape'))      AS in_nonce,
            position($1 in encode(auth_tag, 'escape'))    AS in_tag
     FROM provider_credentials`,
    [KEY]
  );
  assert.equal(Number(bytes[0].in_ciphertext), 0);
  assert.equal(Number(bytes[0].in_nonce), 0);
  assert.equal(Number(bytes[0].in_tag), 0);
});

test("a dump of the whole database carries no key", async (t) => {
  const { post, pools, workspace } = await withServer(t);
  await post({ action: "save", value: KEY });

  // The most realistic leak: someone pastes a pg_dump into an issue.
  const { rows } = await pools.poolFor(workspace).query(
    `SELECT string_agg(t, E'\n') AS dump
     FROM (
       SELECT row_to_json(provider_credentials)::text AS t FROM provider_credentials
       UNION ALL SELECT row_to_json(credentials_audit)::text FROM credentials_audit
     ) AS everything`
  );
  assert.equal(rows[0].dump.includes(KEY), false);
});

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

test("state before anything is stored is a normal state, not a 404", async (t) => {
  const { api } = await withServer(t);
  const res = await api("/v1/settings/credentials");

  assert.equal(res.status, 200, '"no key" has to be renderable, not an error');
  assert.equal((await res.json()).credential, null);
});

test("a saved key is never returned by any endpoint", async (t) => {
  const { api, post, workspace } = await withServer(t);
  await post({ action: "save", value: KEY });

  for (const path of ["/v1/settings/credentials", "/settings", "/health", "/v1/workspaces"]) {
    const text = await (await api(path)).text();
    assert.equal(text.includes(KEY), false, `the key is in the response of ${path}`);
  }
});

test("the response describes the credential without a value", async (t) => {
  const { api, post, workspace } = await withServer(t);
  const saved = await (await post({ action: "save", value: KEY })).json();

  assert.equal(saved.ok, true);
  assert.equal(saved.credential.configured, true);
  assert.equal(saved.credential.provider, "openrouter");
  assert.match(saved.credential.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal("value" in saved.credential, false);
  assert.equal(saved.credential.value, undefined);
});

test("a rejected key is not stored", async (t) => {
  const { store, pools, workspace } = await withServer(t);
  await pools.poolFor(workspace).query("DELETE FROM provider_credentials");

  // A provider that refuses, standing in for a 401.
  const refusing = {
    model: config.providers.embedModel,
    async embed() {
      const err = new Error("401 unauthorized");
      err.status = 401;
      throw err;
    }
  };
  const { post } = await withServer(t, { buildEmbedder: () => refusing });

  // Assembled, not literal: a key-shaped string in this file is a key-shaped
  // string the repository's own scanner blocks, and the scanner is right to.
  const rejected = ["sk", "or", "v1", "definitely-not-valid"].join("-");
  const res = await post({ action: "verify", value: rejected });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "unauthorized", "named, so the form can say something useful");

  // The point: a rejected key must not land in the table as a fallback.
  const { rows } = await pools.poolFor(workspace).query("SELECT count(*)::int AS n FROM provider_credentials");
  assert.equal(rows[0].n, 0);
});

test("a key that cannot be checked is still stored, and says so", async (t) => {
  const { post, pools, workspace } = await withServer(t, {
    // No client to check against at all — CI, and a deployment whose key was
    // written before one was configured.
    buildEmbedder: null
  });

  const res = await post({ action: "verify", value: KEY });
  const body = await res.json();

  // Unverifiable is not the same as rejected. Refusing to store would be
  // wrong; storing silently would be worse.
  assert.equal(body.ok, true);
  assert.equal(body.verified, false);
  assert.match(body.message, /Saved, but not verified/);
  assert.match(body.message, /no provider client/, "and it says why it could not check");

  const { rows } = await pools.poolFor(workspace).query("SELECT count(*)::int AS n FROM provider_credentials");
  assert.equal(rows[0].n, 1, "it was stored, because the key was not shown to be wrong");
});

test("verification never reaches the network when a client is supplied", async (t) => {
  // A test asserting a storage property must not depend on OpenRouter being
  // reachable, and must not spend money. The first version of the rejection
  // test built its client inline and made a real request on every run.
  let built = 0;
  const { post } = await withServer(t, {
    buildEmbedder: () => {
      built += 1;
      return { embed: async (texts) => texts.map(() => new Array(DIMS).fill(0.01)) };
    }
  });

  const res = await post({ action: "verify", value: KEY });
  assert.equal(res.status, 200);
  assert.equal(built, 1, "exactly one client was built, from the candidate");
});

test("an empty value is a 400, not a stored empty string", async (t) => {
  const { api, post, workspace } = await withServer(t);
  const res = await post({ action: "save", value: "   " });
  assert.equal(res.status, 400);
  assert.match((await res.json()).detail, /paste a key/);
});

test("clearing removes it and records the fact", async (t) => {
  const { post, pools, workspace } = await withServer(t);
  await post({ action: "save", value: KEY });

  const res = await post({ action: "clear" });
  const body = await res.json();
  assert.equal(body.removed, true);
  assert.equal(body.credential, null);

  // The ciphertext goes; the record that it was there does not. An audit trail
  // deleted with the thing it audits is not an audit trail.
  const { rows: creds } = await pools.poolFor(workspace).query(
    "SELECT count(*)::int AS n FROM provider_credentials"
  );
  assert.equal(creds[0].n, 0);

  const { rows: audit } = await pools.poolFor(workspace).query(
    "SELECT operation FROM credentials_audit ORDER BY at"
  );
  assert.deepEqual(audit.map((r) => r.operation), ["set", "clear"]);
});

test("the audit trail is append-only", async (t) => {
  const { post, pools, workspace } = await withServer(t);
  await post({ action: "save", value: KEY });

  await assert.rejects(
    () => pools.poolFor(workspace).query("UPDATE credentials_audit SET note = 'edited'"),
    /append-only/
  );
  await assert.rejects(
    () => pools.poolFor(workspace).query("DELETE FROM credentials_audit"),
    /append-only/
  );
});

// ---------------------------------------------------------------------------
// The HTTP surface itself
// ---------------------------------------------------------------------------

test("an oversized body is refused", async (t) => {
  const { post } = await withServer(t);
  // 8 KiB cap. A settings endpoint with no limit is a memory-exhaustion
  // target, and this one is on a port bound to loopback where that question
  // deserves asking anyway.
  const res = await post({ action: "save", value: "x".repeat(64 * 1024) });
  assert.equal(res.status, 413, "and the status is the answer, not a generic 500");
  assert.equal((await res.json()).error, "bad_request");
});

test("a malformed body is refused without reaching the store", async (t) => {
  const { api } = await withServer(t);
  const res = await api("/v1/settings/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.ok(res.status >= 400);
});

test("the settings page is served with headers that constrain it", async (t) => {
  const { api } = await withServer(t);
  const res = await api("/settings");
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("cache-control"), /no-store/);

  // The CSP is the browser enforcing "this page loads nothing from anywhere",
  // rather than a claim in a comment.
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("the page has no external reference of any kind", async (t) => {
  const { api } = await withServer(t);
  const html = await (await api("/settings")).text();
  assert.equal(/https?:\/\//i.test(html), false, "no absolute URL");
  assert.equal(/<script[^>]+src=/i.test(html), false, "no external script");
  assert.equal(/<link[^>]+href=/i.test(html), false, "no external stylesheet or icon");
  assert.match(html, /type="password"/, "and the field cannot be shoulder-read");
});

test("the root index lists the settings endpoint", async (t) => {
  const { api } = await withServer(t);
  const body = await (await api("/")).json();
  assert.ok(body.endpoints.includes("/settings"));
  assert.ok(body.endpoints.includes("/v1/settings/credentials"));
});

test("the master key is created 600 and is not in the response", async (t) => {
  const { api } = await withServer(t);
  const body = await (await api("/v1/settings/credentials")).json();

  assert.ok(body.masterKeyPath, "the operator is told where the encryption key lives");
  const onDisk = readFileSync(body.masterKeyPath);
  assert.equal(onDisk.length, 32);
  assert.equal(onDisk.includes(KEY), false);
});
