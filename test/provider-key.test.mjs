import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.mjs";

/**
 * Key handling.
 *
 * A key that leaks is not recoverable by deleting a file afterwards, so these
 * tests are about the *path* the key takes rather than the value: where it may
 * be read from, where it may never be read from, and what the code does about
 * whitespace, quoting and the several ways a correct setup still produces a 401.
 *
 * The literal is assembled at runtime. A real-looking key in this file would be
 * caught by the repository's own secret-scan — and it would be caught for
 * good reason.
 */

const KEY = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
const BASE = { POSTGRES_PASSWORD: "unused" };

function scratch() {
  return mkdtempSync(join(tmpdir(), "jove-key-"));
}

test("no key anywhere is an empty string, not a crash", () => {
  // The stack has to start and serve health without one — Phase 2's gate.
  // A missing key that throws at boot turns "not configured yet" into a
  // crash-loop.
  const config = loadConfig({ ...BASE, HOME: scratch() });
  assert.equal(config.providers.apiKey, "");
  assert.equal(config.providers.keySource, null);
});

test("the key is read from a file outside the repository", () => {
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, KEY);

  const config = loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: file });

  assert.equal(config.providers.apiKey, KEY);
  assert.equal(config.providers.keySource, `file:${file}`);
  rmSync(dir, { recursive: true, force: true });
});

test("a key file inside the repository is refused outright", () => {
  // Not a warning. A gitignored file is still a file in a directory that gets
  // zipped, backed up and rsynced, and a warning is something that gets
  // clicked past exactly once.
  const repoLocal = join(process.cwd(), ".env.local");
  assert.throws(
    () => loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: repoLocal }),
    (err) => {
      assert.match(err.message, /Refusing to read a provider key from inside the project/);
      assert.match(err.message, /git add/);
      return true;
    }
  );
  assert.equal(existsSync(repoLocal), false, "and it does not create the file it refused");
});

test("a repository-relative path is caught, not just an absolute one", () => {
  assert.throws(
    () => loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: "./secrets/openrouter.key" }),
    /Refusing to read a provider key from inside the project/
  );
});

test("a home directory that happens to be named like the project is allowed", () => {
  // The previous version of this check tested for the substring `jove-memory`
  // anywhere in the path, which rejected the very file it pointed at
  // (~/.config/jove-memory/openrouter.key) and would also have rejected an
  // unrelated directory with the same name somewhere else on the disk.
  const dir = scratch();
  const nested = join(dir, "jove-memory");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "openrouter.key"), KEY);

  const config = loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: join(nested, "openrouter.key") });
  assert.equal(config.providers.apiKey, KEY);
  rmSync(dir, { recursive: true, force: true });
});

test("trailing whitespace and quotes are stripped", () => {
  // The single most common way an otherwise-correct setup produces a 401 that
  // looks like a wrong key: a paste from a web page brings a newline, and a
  // copy from a config file brings quotes.
  const dir = scratch();
  const file = join(dir, "openrouter.key");

  for (const messy of [`${KEY}\n`, `  ${KEY}  `, `"${KEY}"`, `'${KEY}'`, `\n${KEY}\n\n`]) {
    writeFileSync(file, messy);
    const config = loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: file });
    assert.equal(config.providers.apiKey, KEY, `failed to clean up ${JSON.stringify(messy)}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("an environment key wins over a file, and says so", () => {
  // CI has no file, and someone who already exports the key should not have
  // their value silently overridden by a stale one on disk.
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, KEY);

  // Assembled from a fragment, so this file does not contain a string that
  // matches the repository's own secret-scan. A literal here is a literal
  // here, and push protection would block the commit — correctly.
  const fromEnv = `${KEY.split("-").slice(0, 3).join("-")}-from-the-environment`;
  const config = loadConfig({ ...BASE, OPENROUTER_API_KEY: fromEnv, OPENROUTER_API_KEY_FILE: file });

  assert.equal(config.providers.apiKey, fromEnv);
  assert.equal(config.providers.keySource, "environment");
  rmSync(dir, { recursive: true, force: true });
});

test("a missing key file is not an error, just a missing key", () => {
  // Most deployments have no key. The health endpoint has to work there.
  const config = loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: join(scratch(), "absent") });
  assert.equal(config.providers.apiKey, "");
  assert.equal(config.providers.keySource, null);
});

test("an empty key file is treated as no key", () => {
  // A file left behind by a failed save. Reading it as an empty key would
  // produce a 401 that looks like a wrong key rather than an unfinished setup.
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, "\n   \n");

  const config = loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: file });
  assert.equal(config.providers.apiKey, "");
  rmSync(dir, { recursive: true, force: true });
});

test("the source is reset between loads", () => {
  // Two loads in one process must not report each other's source. A stale
  // `file:` pointing at a path that no longer answers is exactly the kind of
  // misleading detail this field exists to avoid.
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, KEY);

  loadConfig({ ...BASE, OPENROUTER_API_KEY_FILE: file });
  const second = loadConfig({ ...BASE, HOME: scratch() });

  assert.equal(second.providers.keySource, null);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The setup script
// ---------------------------------------------------------------------------

test("the key file the setup script writes is not inside the repository", () => {
  // Read from the script rather than by running it: the script's contract is
  // where it writes, and that is a static property. Running it would need a
  // TTY and would overwrite whatever the user actually has.
  const source = readFileSync("scripts/set-provider-key.mjs", "utf8");

  // The location is a static property of the script, so it is asserted from
  // the source rather than by running it. Running it would need a TTY and
  // would overwrite whatever key the user actually has.
  assert.match(
    source,
    /join\(homedir\(\), "\.config", "jove-memory"\)/,
    "it writes under the user's config directory, resolved from the real home"
  );
  assert.ok(
    !source.includes('join("..")') && !source.includes('"./'),
    "and never a path relative to the working directory"
  );
  assert.match(
    source,
    /process\.env\.JOVE_SECRETS_DIR/,
    "overridable, so nothing in the repository depends on that path existing"
  );
});

test("the setup script never prints the value it read", () => {
  const source = readFileSync("scripts/set-provider-key.mjs", "utf8");

  // The only thing reported about the key is its length. Enough to catch an
  // empty paste, not enough to reconstruct anything.
  assert.ok(
    !/out\([^)]*key\b(?!\)|[\s,;]*$)/i.test(source) || !/\$\{key\}/.test(source),
    "the key must never be interpolated into output"
  );
  assert.ok(!source.includes("${key}"), "the raw value must not appear in a template");
  assert.match(source, /read -rs/, "and it must be read with echo off");
  assert.match(source, /0o600/, "written 600");
  assert.match(source, /0o700/, "in a 700 directory");
});

test("the health endpoint reports the key source, never the key", () => {
  const source = readFileSync("src/api/server.mjs", "utf8");
  assert.match(source, /keySource/);
  assert.ok(
    !/source:\s*config\.providers\.apiKey/.test(source),
    "the source field must never be assigned the value"
  );
});
