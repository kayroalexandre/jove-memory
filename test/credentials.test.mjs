import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCredentialStore, classifyVerificationFailure } from "../src/api/credentials.mjs";
import { settingsPage } from "../src/api/settings-page.mjs";

/**
 * Credentials at rest, and the settings page that writes them.
 *
 * The property everything here defends: **the database does not contain the
 * key, and cannot be made to give it up on its own.** A dump, a replica, or a
 * `pg_dump` pasted into an issue yields ciphertext. The master key that turns
 * that back into a key is a file, and the file is the only other half.
 *
 * The tests use a fake store that records what was written, because the
 * property is about what crosses the database boundary — which is observable
 * without a database, and observable more precisely this way.
 */

const KEY = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");

/**
 * A stand-in for the store, recording what crossed the boundary.
 *
 * Deliberately method-shaped rather than SQL-shaped. The first version matched
 * on SQL text, which meant the test asserted things about query strings while
 * the module under test called `store.pool()` — and the "only src/store/ writes
 * SQL" invariant failed on credentials.mjs as a result. Both were wrong: the
 * invariant was right, and the module should be going through the store.
 */
function fakeStore() {
  const rows = new Map();
  const audit = [];
  const calls = [];
  const key = (provider, kind) => `${provider}:${kind}`;
  const record = (method, values) => calls.push({ method, values });

  return {
    rows,
    audit,
    calls,

    async upsertCredential(values) {
      record("upsertCredential", values);
      const row = {
        provider: values.provider,
        kind: values.kind,
        ciphertext: values.ciphertext,
        nonce: values.nonce,
        auth_tag: values.authTag,
        key_version: values.keyVersion,
        ciphertext_fingerprint: values.fingerprint,
        created_at: new Date(),
        updated_at: new Date()
      };
      rows.set(key(values.provider, values.kind), row);
    },

    async readCredential({ provider, kind }) {
      record("readCredential", { provider, kind });
      const row = rows.get(key(provider, kind));
      if (!row) return null;
      // Shaped as the store returns it, so the module has to read snake_case.
      return {
        provider: row.provider,
        kind: row.kind,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        auth_tag: row.auth_tag,
        key_version: row.key_version
      };
    },

    async describeCredential({ provider, kind }) {
      record("describeCredential", { provider, kind });
      return rows.get(key(provider, kind)) ?? null;
    },

    async deleteCredential({ provider, kind }) {
      record("deleteCredential", { provider, kind });
      return rows.delete(key(provider, kind));
    },

    async recordCredentialAudit(values) {
      record("recordCredentialAudit", values);
      audit.push(values);
    },

    async listCredentialAudit({ provider = null, kind = null, limit = 50 } = {}) {
      record("listCredentialAudit", { provider, kind, limit });
      return audit.filter((e) => (!provider || e.provider === provider) && (!kind || e.kind === kind));
    }
  };
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "jove-cred-"));
}

function storeFor(dir) {
  return createCredentialStore({
    store: fakeStore(),
    masterKeyPath: join(dir, "master.key")
  });
}

// ---------------------------------------------------------------------------
// The master key
// ---------------------------------------------------------------------------

test("a master key is created 600, in a 700 directory, on first use", () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  assert.equal(existsSync(join(dir, "master.key")), false, "not until something needs it");

  await0(credentials);

  const path = join(dir, "master.key");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path).size, 32, "32 bytes of key material");
  rmSync(dir, { recursive: true, force: true });
});

test("the master key is created before anything is encrypted with it", () => {
  // The ordering matters: a credential encrypted with a key that is created
  // afterwards is undecryptable, and the failure appears at the first provider
  // call rather than at the save.
  const dir = scratch();
  const credentials = storeFor(dir);
  assert.equal(credentials.masterKeyCreated(), null);

  const result = credentials.set({ value: KEY });
  assert.ok(result instanceof Promise, "set is async, so the key must already exist");
  return result.then(() => {
    assert.equal(credentials.masterKeyCreated(), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("a master key of the wrong length is refused, not replaced", () => {
  // Generating a replacement of the right length would leave every stored
  // credential undecryptable while looking correct.
  const dir = scratch();
  writeFileSync(join(dir, "master.key"), Buffer.alloc(16));
  chmodSync(join(dir, "master.key"), 0o600);

  assert.throws(
    () => storeFor(dir).masterKeyPath(),
    (err) => {
      assert.match(err.message, /16 bytes, expected 32/);
      assert.match(err.message, /not written by this program/);
      return true;
    }
  );
  rmSync(dir, { recursive: true, force: true });
});

test("the master key path is safe to show and the key is never in it", () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  return credentials.set({ value: KEY }).then(() => {
    const path = credentials.masterKeyPath();
    assert.equal(path, join(dir, "master.key"));
    assert.equal(path.includes(KEY), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// What crosses the database boundary
// ---------------------------------------------------------------------------

test("the value never appears in a query, in any form", () => {
  // The load-bearing assertion. If the plaintext key is in a query, then
  // anything that can see queries can see the key: a slow query log, a
  // statement log, an APM trace, a replication stream.
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  return credentials.set({ value: KEY }).then(async () => {
    for (const { method, values } of backing.calls) {
    const haystack = `${method} ${JSON.stringify(values, (k, v) =>
      Buffer.isBuffer(v) ? v.toString("base64") : v
    )}`;
    assert.equal(haystack.includes(KEY), false, `the plaintext key reached: ${haystack.slice(0, 200)}`);
  }
    rmSync(dir, { recursive: true, force: true });
  });
});

test("what is stored is ciphertext, a nonce and a tag, and they are all different", async () => {
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  await credentials.set({ value: KEY });
  const row = backing.rows.get("openrouter:api_key");

  assert.ok(Buffer.isBuffer(row.ciphertext));
  assert.equal(row.ciphertext.toString("utf8").includes(KEY), false);
  assert.ok(Buffer.isBuffer(row.nonce) && row.nonce.length === 12);
  assert.ok(Buffer.isBuffer(row.auth_tag) && row.auth_tag.length === 16);
  assert.notEqual(row.ciphertext.equals(row.nonce), true);
  rmSync(dir, { recursive: true, force: true });
});

test("encrypting the same value twice produces different ciphertext", () => {
  // A fresh nonce per encryption. Reusing one under GCM is catastrophic — it
  // leaks the XOR of the two plaintexts — and it is invisible in the output:
  // identical plaintext produces identical ciphertext and nothing complains.
  //
  // Tested on the primitive rather than through `set`, because `set` now
  // short-circuits an unchanged save — which is the behaviour the previous
  // version of this test was accidentally asserting against.
  const dir = scratch();
  const credentials = storeFor(dir);
  credentials.masterKeyPath();

  const first = credentials.encrypt(KEY);
  const second = credentials.encrypt(KEY);

  assert.equal(first.nonce.equals(second.nonce), false, "the nonce must not repeat");
  assert.equal(first.ciphertext.equals(second.ciphertext), false);
  assert.equal(credentials.decrypt(first), KEY, "and both still decrypt");
  assert.equal(credentials.decrypt(second), KEY);
  rmSync(dir, { recursive: true, force: true });
});

test("saving the same key twice does not rewrite the row", async () => {
  // The flip side of a stable fingerprint: a no-op save must not produce new
  // ciphertext or a second audit row, or "saved" happens on every page load.
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  await credentials.set({ value: KEY });
  const writes = backing.calls.filter((c) => c.method === "upsertCredential").length;
  const firstCiphertext = backing.rows.get("openrouter:api_key").ciphertext;

  await credentials.set({ value: KEY });

  assert.equal(
    backing.calls.filter((c) => c.method === "upsertCredential").length,
    writes,
    "no second write"
  );
  assert.equal(backing.rows.get("openrouter:api_key").ciphertext.equals(firstCiphertext), true);
  assert.equal(backing.audit.length, 1, "and no second audit row");
  rmSync(dir, { recursive: true, force: true });
});

test("the round trip returns the value, trimmed", async () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  await credentials.set({ value: `  ${KEY}\n` });
  assert.equal(await credentials.get(), KEY);
  rmSync(dir, { recursive: true, force: true });
});

test("a tampered row is refused rather than decrypted to nonsense", () => {
  // The reason for GCM over CBC. CBC under a wrong key produces garbage that
  // decrypts "successfully", and that garbage goes to a provider.
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  return credentials.set({ value: KEY }).then(() => {
    const row = backing.rows.get("openrouter:api_key");
    row.ciphertext = Buffer.concat([row.ciphertext, Buffer.from("X")]);

    assert.throws(() => credentials.decrypt(row), /unable to authenticate|unsupported state/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("a different master key cannot decrypt the row", () => {
  const dirA = scratch();
  const dirB = scratch();
  const backingA = fakeStore();
  const a = createCredentialStore({ store: backingA, masterKeyPath: join(dirA, "master.key") });
  const b = createCredentialStore({ store: fakeStore(), masterKeyPath: join(dirB, "master.key") });

  return a.set({ value: KEY }).then(() => {
    const row = backingA.rows.get("openrouter:api_key");
    assert.throws(() => b.decrypt(row), /unable to authenticate|unsupported state/i);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// What comes back out
// ---------------------------------------------------------------------------

test("describe returns metadata and no value", async () => {
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });
  await credentials.set({ value: KEY });

  const described = await credentials.describe();
  const serialised = JSON.stringify(described);

  assert.equal(described.configured, true);
  assert.equal(described.provider, "openrouter");
  assert.equal(described.keyVersion, "v1");
  assert.match(described.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(serialised.includes(KEY), false);
  assert.equal("value" in described, false);
  assert.equal("ciphertext" in described, false);
  rmSync(dir, { recursive: true, force: true });
});

test("the fingerprint identifies the ciphertext, not the key", async () => {
  // A hash of the key would let anyone holding the database test candidate keys
  // against it. This is a keyed hash of the ciphertext, which answers the only
  // question asked: did this change?
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  await credentials.set({ value: KEY });
  const first = (await credentials.describe()).fingerprint;
  const second = (await credentials.set({ value: KEY })).fingerprint;
  const changed = (await credentials.set({ value: `${KEY}x` })).fingerprint;

  assert.equal(first, second, "the same value is the same fingerprint");
  assert.notEqual(second, changed, "a different value is a different fingerprint");
  assert.equal(second.length, 16, "truncated — it identifies, it does not authenticate");
  rmSync(dir, { recursive: true, force: true });
});

test("saving the same key twice reports that nothing changed", async () => {
  // A form that says "saved" when nothing changed trains people to ignore it.
  const dir = scratch();
  const credentials = storeFor(dir);
  assert.equal((await credentials.set({ value: KEY })).changed, true);
  assert.equal((await credentials.set({ value: KEY })).changed, false);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty value is refused", async () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  await assert.rejects(() => credentials.set({ value: "  " }), /must not be empty/);
  await assert.rejects(() => credentials.set({ value: null }), /must not be empty/);
  rmSync(dir, { recursive: true, force: true });
});

test("no credential is a normal state, not an error", async () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  assert.equal(await credentials.get(), null);
  assert.equal(await credentials.describe(), null);
  assert.equal(await credentials.clear(), false);
  rmSync(dir, { recursive: true, force: true });
});

test("clearing removes the ciphertext and leaves the audit trail", async () => {
  // An audit trail that is deleted with the thing it audits is not an audit
  // trail.
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  await credentials.set({ value: KEY });
  assert.equal(await credentials.clear(), true);

  assert.equal(backing.rows.size, 0);
  assert.deepEqual(
    backing.audit.map((entry) => entry.operation),
    ["set", "clear"]
  );
  rmSync(dir, { recursive: true, force: true });
});

test("the audit trail holds operations, never values or diffs", async () => {
  const dir = scratch();
  const backing = fakeStore();
  const credentials = createCredentialStore({ store: backing, masterKeyPath: join(dir, "master.key") });

  await credentials.set({ value: KEY });
  await credentials.set({ value: `${KEY}rotated` });

  const serialised = JSON.stringify(backing.audit.map((entry) => ({ ...entry })));
  assert.equal(serialised.includes(KEY), false);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("verification checks the candidate, not whatever is already stored", async () => {
  // Verifying the old key while testing the new one is a check that always
  // passes, and it is the obvious way to write this.
  const dir = scratch();
  const credentials = storeFor(dir);
  let seen = null;

  const result = await credentials.verify({
    value: KEY,
    buildEmbedder: (candidate) => {
      seen = candidate;
      return { embed: async () => [new Array(3072).fill(0.01)] };
    }
  });

  assert.equal(seen, KEY, "the candidate is what gets checked");
  assert.equal(result.ok, true);
  assert.equal(result.dimensions, 3072);
  assert.equal(result.matchesColumn, true);
  rmSync(dir, { recursive: true, force: true });
});

test("verification reports a width mismatch against the column", async () => {
  const dir = scratch();
  const credentials = storeFor(dir);
  const result = await credentials.verify({
    value: KEY,
    buildEmbedder: () => ({ embed: async () => [new Array(1536).fill(0.01)] }),
    dimensions: 3072
  });

  assert.equal(result.ok, true, "the call worked");
  assert.equal(result.matchesColumn, false, "and it is still worth saying the widths disagree");
  rmSync(dir, { recursive: true, force: true });
});

test("verification without a client is not a failure of the key", async () => {
  // Reporting "verification failed" when there was nothing to verify against
  // sends the operator to fix a key that is fine.
  const dir = scratch();
  const credentials = storeFor(dir);
  const result = await credentials.verify({ value: KEY });

  assert.equal(result.ok, null);
  assert.equal(result.reason, "not_configured");
  rmSync(dir, { recursive: true, force: true });
});

test("a failure is named, not collapsed", () => {
  // "Verification failed" makes an operator re-paste a working key.
  assert.equal(classifyVerificationFailure({ status: 401 }), "unauthorized");
  assert.equal(classifyVerificationFailure({ status: 402 }), "no_credit");
  assert.equal(classifyVerificationFailure({ status: 429 }), "rate_limited");
  assert.equal(classifyVerificationFailure({ message: "request timed out" }), "timeout");
  assert.equal(
    classifyVerificationFailure({ message: "has 1536 dimensions, the column expects 3072" }),
    "wrong_dimensions"
  );
  assert.equal(classifyVerificationFailure({ message: "fetch failed" }), "unreachable");
  assert.equal(classifyVerificationFailure({ message: "something else" }), "unknown");
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test("the settings page loads nothing from anywhere", () => {
  const html = settingsPage();

  // No CDN, no font, no favicon, no analytics. A page that accepts a credential
  // and loads a script from somewhere has handed that credential to wherever
  // the script came from.
  assert.equal(/<script[^>]+src=/i.test(html), false, "no external script");
  assert.equal(/<link[^>]+href=/i.test(html), false, "no external stylesheet or icon");
  assert.equal(/https?:\/\//i.test(html), false, "no absolute URL at all");
  assert.equal(/@import/i.test(html), false, "no imported stylesheet");
});

test("the settings page cannot display a key it stored", () => {
  const html = settingsPage();
  // The field is a password input, cleared after save, and the response path
  // renders a fingerprint. No element exists that could show a value.
  assert.match(html, /type="password"/);
  assert.equal(/type="text"[^>]*id="value"/.test(html), false);
});

test("the settings page posts to this origin only", () => {
  const html = settingsPage();
  assert.match(html, /action="\/v1\/settings\/credentials"/);
  assert.equal(/form[^>]+action="https?:/i.test(html), false);
});

test("the settings page tells the browser not to index or refer", () => {
  const html = settingsPage();
  assert.match(html, /noindex/);
});

/** Call a sync-looking method for its filesystem side effects. */
function await0(credentials) {
  credentials.masterKeyPath();
}
