import { randomBytes, createCipheriv, createDecipheriv, createHmac, scryptSync } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { secureDirectory } from "../../scripts/lib/secure-file.mjs";

/**
 * Provider credentials, encrypted at rest.
 *
 * The design constraint that shapes everything: **the encryption key is not in
 * the database.** If it were, a database dump would contain a credential and
 * the encryption would be formatting.
 *
 * So the master key is 32 random bytes in a mode-600 file outside the
 * repository, and the database holds only ciphertext, nonce and auth tag. The
 * two halves live in different places with different exposure: the database is
 * reachable from the container network, the file is not.
 *
 * What this does not do: protect against an attacker who can read both the
 * database and the filesystem as this user. At that point the key is
 * recoverable. docs/SECURITY.md states the threat model that is actually
 * claimed, as opposed to the one that is not.
 *
 * AES-256-GCM rather than AES-CBC because the authentication tag is the
 * property that matters. CBC under a wrong key produces garbage that decrypts
 * "successfully"; GCM refuses, so a tampered or corrupted row is an error
 * rather than a wrong credential sent to a provider.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION = "v1";

function masterKeyPath(explicitPath) {
  return (
    explicitPath ??
    process.env.JOVE_MASTER_KEY_FILE ??
    join(process.env.JOVE_SECRETS_DIR ?? join(homedir(), ".config", "jove-memory"), "master.key")
  );
}

/**
 * Load the master key, or create it.
 *
 * Lazy on first use, not at module load. A module-load side effect that writes
 * a file is a side effect nobody asked for, and it happens in every test that
 * imports this module.
 *
 * Called per credential store rather than cached at module scope. The first
 * version kept the result in a module-level variable, so two stores in one
 * process shared one master key — a second workspace's credential would be
 * encrypted with the first workspace's key, and a test creating a store in a
 * scratch directory silently inherited whatever key an earlier test had
 * loaded. The server creates one store today, which is why nothing broke, and
 * that is exactly the kind of latent coupling that surfaces later as a
 * security bug rather than a test failure.
 */
function loadMasterKey(explicitPath) {
  const path = masterKeyPath(explicitPath);

  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length !== KEY_BYTES) {
      throw new Error(
        `The master key at ${path} is ${raw.length} bytes, expected ${KEY_BYTES}.\n` +
          "  It was not written by this program, or it is truncated. Generating a\n" +
          "  replacement of the right length would leave every stored credential\n" +
          "  undecryptable while looking correct — the failure would surface at the\n" +
          "  first provider call, not here."
      );
    }
    return { key: raw, path, created: false };
  }

  const dir = dirname(path);
  const verdict = secureDirectory(dir);
  if (!verdict.usable) {
    throw new Error(
      `Cannot create the master key directory ${dir}: ${verdict.reason}\n` +
        "  Point JOVE_SECRETS_DIR at a directory you own, on a filesystem that\n" +
        "  supports permissions."
    );
  }

  const key = randomBytes(KEY_BYTES);
  // Mode 600 at creation, temporary file then rename. A partially written
  // master key is unrecoverable, and an interrupted write is the likeliest way
  // to produce one.
  const temporary = join(dir, `.master.key.${process.pid}`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeSync(handle, key, 0, key.length);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);

  return { key, path, created: true };
}

export function createCredentialStore({ store, masterKeyPath: explicitPath = null, logger = null }) {
  let master = null;
  const key = () => {
    if (!master) master = loadMasterKey(explicitPath);
    return master;
  };

  /**
   * A stable fingerprint of the value, for "is this the same key as before?".
   *
   * Keyed, and of the *value* rather than of the ciphertext. Both details
   * matter, and the first version had the second one wrong:
   *
   *   - Of the ciphertext, because GCM uses a fresh nonce per write, a
   *     ciphertext fingerprint changes on every save. That makes "unchanged"
   *     unreachable, so the form reports a change every time a key is saved
   *     unchanged, and a report that is always "changed" is a report nobody
   *     reads.
   *   - Keyed with the master key, because an unkeyed hash of the value would
   *     let anyone holding the database test candidate keys against it. With
   *     the master key as the HMAC key, an attacker who has only the database
   *     cannot; and an attacker who also has the master key can decrypt
   *     outright, so the fingerprint adds nothing they did not already have.
   *
   * Truncated to 16 hex characters. It identifies, it does not authenticate —
   * the auth tag does that.
   */
  const fingerprint = (value) =>
    createHmac("sha256", key().key).update(`credential:${value}`).digest("hex").slice(0, 16);

  function encrypt(value) {
    const trimmed = String(value).trim();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key().key, nonce);
    const ciphertext = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
    return {
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      keyVersion: KEY_VERSION,
      fingerprint: fingerprint(trimmed)
    };
  }

  /**
   * Decrypt a row.
   *
   * Accepts both the camelCase shape this module produces and the snake_case
   * shape PostgreSQL returns. The first version read only `authTag`, and every
   * round trip through the database passed `undefined` to `setAuthTag` — a
   * TypeError from deep inside OpenSSL that named neither the table nor the
   * column.
   */
  function decrypt(row) {
    const ciphertext = row.ciphertext;
    const nonce = row.nonce;
    const authTag = row.authTag ?? row.auth_tag;

    if (!ciphertext || !nonce || !authTag) {
      throw new Error(
        `Credential row for ${row.provider ?? "?"}/${row.kind ?? "?"} is missing ` +
          `${[!ciphertext && "ciphertext", !nonce && "nonce", !authTag && "auth_tag"]
            .filter(Boolean)
            .join(", ")}.`
      );
    }

    const decipher = createDecipheriv(ALGORITHM, key().key, nonce);
    decipher.setAuthTag(authTag);
    // Throws when the tag does not verify: a wrong master key, a tampered row,
    // a corrupted byte. All three are errors, and none of them may produce a
    // plausible-looking wrong credential.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  const audit = (provider, kind, operation, note) =>
    store.recordCredentialAudit({ provider, kind, operation, note });

  /**
   * Store a credential.
   *
   * The fingerprint is compared first, so saving the same key twice is a no-op
   * with a distinct result. A settings form that reports "changed" when nothing
   * changed trains people to ignore it.
   */
  async function set({ provider = "openrouter", kind = "api_key", value, note = null }) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("A credential value is required, and it must not be empty.");
    }

    const trimmed = value.trim();
    const before = await describe({ provider, kind });

    // Compared before encrypting, so an unchanged save does not produce
    // pointless ciphertext and a pointless audit row.
    if (before && before.fingerprint === fingerprint(trimmed)) {
      return { ...before, changed: false };
    }

    const sealed = encrypt(trimmed);

    await store.upsertCredential({
      provider,
      kind,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      authTag: sealed.authTag,
      keyVersion: sealed.keyVersion,
      fingerprint: sealed.fingerprint
    });

    await audit(provider, kind, "set", note);

    return { ...(await describe({ provider, kind })), changed: true };
  }

  /**
   * The decrypted credential.
   *
   * Null when none is stored — a normal state, not an error, since the health
   * endpoint has to work without one.
   */
  async function get({ provider = "openrouter", kind = "api_key" } = {}) {
    const row = await store.readCredential({ provider, kind });
    if (!row) return null;
    return decrypt(row);
  }

  /** Metadata about a stored credential, with no value in it. */
  async function describe({ provider = "openrouter", kind = "api_key" } = {}) {
    const row = await store.describeCredential({ provider, kind });
    return row ? describeRow(row) : null;
  }

  /** Remove a credential. The ciphertext, not the audit trail. */
  async function clear({ provider = "openrouter", kind = "api_key", note = null } = {}) {
    const removed = await store.deleteCredential({ provider, kind });
    if (!removed) return false;

    await audit(provider, kind, "clear", note);
    return true;
  }

  /**
   * The audit trail, newest first.
   *
   * Operations and timestamps. Never a value, never a diff — a diff of two
   * keys is not reconstructible and is a leak waiting for a use case.
   */
  async function history(options = {}) {
    return store.listCredentialAudit(options);
  }

  /**
   * Check a candidate against the provider, without storing it.
   *
   * This is why the settings form is worth having: the operator learns a key is
   * wrong *before* saving it, rather than from a failed search twenty minutes
   * later.
   *
   * `buildEmbedder` is injected so the check runs against the candidate rather
   * than against whatever is already stored. Verifying the old key while
   * testing the new one is a check that always passes.
   */
  async function verify({ value, buildEmbedder, dimensions = 3072 }) {
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, reason: "empty", detail: "no value was provided" };
    }
    if (typeof buildEmbedder !== "function") {
      // Not a failure of the key. Reporting it as one sends the operator to
      // fix something that is not broken.
      return { ok: null, reason: "not_configured", detail: "no provider client to check against" };
    }

    try {
      const embedder = buildEmbedder(value.trim());
      const [vector] = await embedder.embed(["credential check"], { useCache: false });
      if (!Array.isArray(vector)) {
        return { ok: false, reason: "bad_response", detail: "the provider returned no vector" };
      }
      return {
        ok: true,
        dimensions: vector.length,
        matchesColumn: vector.length === dimensions
      };
    } catch (err) {
      return { ok: false, reason: classify(err), detail: err.message };
    }
  }

  return {
    set,
    get,
    describe,
    clear,
    history,
    verify,
    /** Where the master key lives. Safe to log; contains no secret. */
    masterKeyPath: () => key().path,
    masterKeyCreated: () => master?.created ?? null,
    encrypt,
    decrypt
  };
}

/**
 * Name the failure, so the form can say something actionable.
 *
 * A 401 is "the key is wrong"; a 402 is "there is no credit"; a timeout is
 * "the provider is unreachable". Collapsing all three into "verification
 * failed" is what makes an operator re-paste a working key.
 */
function classify(err) {
  const message = String(err?.message ?? "");
  if (err?.status === 401) return "unauthorized";
  if (err?.status === 402) return "no_credit";
  if (err?.status === 404) return "model_not_found";
  if (err?.status === 429) return "rate_limited";
  if (/timed out|abort/i.test(message)) return "timeout";
  if (/dimensions/i.test(message)) return "wrong_dimensions";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return "unreachable";
  return "unknown";
}

/** The shape returned to callers. Deliberately carries no value. */
function describeRow(row) {
  return {
    provider: row.provider,
    kind: row.kind,
    configured: true,
    keyVersion: row.key_version,
    fingerprint: row.ciphertext_fingerprint,
    createdAt: row.created_at?.toISOString?.() ?? null,
    updatedAt: row.updated_at?.toISOString?.() ?? null
  };
}

export { KEY_VERSION, ALGORITHM, classify as classifyVerificationFailure };
