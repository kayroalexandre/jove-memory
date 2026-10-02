import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as configModule from "../src/config.mjs";
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

/** The output sinks a key must never reach. Shared with the negative control. */
const SINKS = [/\bout\(/, /console\.(log|error|warn)\(/, /process\.stdout\.write\(/];

function scratch() {
  return mkdtempSync(join(tmpdir(), "jove-key-"));
}

/**
 * An environment with no key anywhere in it.
 *
 * Every test in this file goes through here, and that is not tidiness. These
 * tests were written before a key existed on this machine, so they passed
 * `{...BASE} HOME: scratch()` and nothing else — and once a real key was stored
 * under the real home directory, the tests that assert "no key is found"
 * started reading the operator's actual credential into the test process, and
 * printed it in the assertion diff.
 *
 * So the isolation is explicit and total: a scratch HOME, and no reliance on
 * the absence of an environment variable that happens to be unset today.
 */
function noKeyEnv(extra = {}) {
  return { ...BASE, ...extra, HOME: scratch(), JOVE_SECRETS_DIR: undefined };
}

/**
 * Assert about a key without ever putting its value in a failure message.
 *
 * `assert.equal(config.providers.apiKey, "")` prints `actual`, and when the
 * real key was found that printed the real key. A boolean comparison says the
 * same thing and cannot leak.
 */
function assertNoKey(config, context) {
  assert.equal(
    config.providers.apiKey === "",
    true,
    `${context}: expected no key, found a ${config.providers.apiKey.length}-character value`
  );
  assert.equal(config.providers.keySource, null, `${context}: and no source`);
}

test("no key anywhere is an empty string, not a crash", () => {
  // The stack has to start and serve health without one — Phase 2's gate.
  // A missing key that throws at boot turns "not configured yet" into a
  // crash-loop.
  const config = loadConfig(noKeyEnv());
  assertNoKey(config, "empty environment");
});

test("the key is read from a file outside the repository", () => {
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, KEY);

  const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: file }));

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
    () => loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: repoLocal })),
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
    () => loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: "./secrets/openrouter.key" })),
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

  const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: join(nested, "openrouter.key") }));
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
    const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: file }));
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
  const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY: fromEnv, OPENROUTER_API_KEY_FILE: file }));

  assert.equal(config.providers.apiKey, fromEnv);
  assert.equal(config.providers.keySource, "environment");
  rmSync(dir, { recursive: true, force: true });
});

test("a missing key file is not an error, just a missing key", () => {
  // Most deployments have no key. The health endpoint has to work there.
  const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: join(scratch(), "absent") }));
  assertNoKey(config, "absent file");
});

test("an empty key file is treated as no key", () => {
  // A file left behind by a failed save. Reading it as an empty key would
  // produce a 401 that looks like a wrong key rather than an unfinished setup.
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, "\n   \n");

  const config = loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: file }));
  assertNoKey(config, "empty file");
  rmSync(dir, { recursive: true, force: true });
});

test("the source is reset between loads", () => {
  // Two loads in one process must not report each other's source. A stale
  // `file:` pointing at a path that no longer answers is exactly the kind of
  // misleading detail this field exists to avoid.
  const dir = scratch();
  const file = join(dir, "openrouter.key");
  writeFileSync(file, KEY);

  loadConfig(noKeyEnv({ OPENROUTER_API_KEY_FILE: file }));
  const second = loadConfig(noKeyEnv());

  assertNoKey(second, "second load");
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

  // The location is no longer a single hardcoded path: the script asks
  // `config.mjs` for candidates and picks the first it can actually secure.
  // That is the fix for the failure this test was written for — the preferred
  // directory was owned by root, so a hardcoded path could not work at all.
  assert.match(
    source,
    /keyDirectoryCandidates/,
    "the script must take its candidate directories from the config module"
  );
  assert.match(
    source,
    /secureDirectory\(/,
    "and must check each one is securable before asking for the key"
  );
  // A relative *import* is fine; a relative *key path* is not, because the
  // script would then be writing into whatever directory it happened to be run
  // from — which is the project.
  assert.ok(
    !/join\(\s*"\.\.?\//.test(source) && !/join\([^)]*"\.\.\//.test(source),
    "no key path may be built relative to the working directory"
  );
  assert.match(
    source,
    /secureWriteFile/,
    "writing must go through the verify-then-delete path, not a bare writeFileSync"
  );
  assert.ok(
    !/\bwriteFileSync\(/.test(source),
    "a bare writeFileSync would create a credential with default permissions"
  );
});

test("the setup script never prints the value it read", () => {
  const source = readFileSync("scripts/set-provider-key.mjs", "utf8");

  // The only thing reported about the key is its length. Enough to catch an
  // empty paste, not enough to reconstruct anything.
  assert.ok(!source.includes("${key}"), "the raw value must not appear in a template");
  assert.match(source, /read -rs/, "and it must be read with echo off");

  // Prose about keys is fine; the *value* reaching output is not. So the
  // strings are stripped before looking for the identifier, which is the only
  // way to tell `out("paste the key")` from `out(key)`.
  //
  // The previous version of this assertion tested "no out() call mentions the
  // word key", which the script's own prompts fail — so it was loosened until
  // it passed, and the property it was written for went untested.
  const code = stripStringsAndComments(source);
  for (const sink of SINKS) {
    assert.ok(
      !new RegExp(`${sink.source}[^)]*\\bkey\\b`).test(code),
      `the value must never reach output via ${sink.source}`
    );
  }

  // The modes moved to lib/secure-file.mjs, so the assertion belongs there.
  const lib = readFileSync("scripts/lib/secure-file.mjs", "utf8");
  assert.match(lib, /0o600/);
  assert.match(lib, /0o700/);
});

/**
 * Remove string literals, template literals and comments.
 *
 * Crude and sufficient: this is a source-text check looking for an identifier
 * in an argument position, and a badly-stripped comment cannot make one appear
 * where it was not.
 */
test("the leak detector is not vacuous", () => {
  // An assertion that cannot fail is not an assertion. Each of these is a
  // snippet that really does leak, fed through the same stripping and the same
  // patterns the real test uses. If the detector ever goes blind — because
  // someone loosened a pattern to make it pass — this fails.
  const leaks = [
    "out(key);",
    "console.log(`the key is ${key}`);",
    "process.stdout.write(key);",
    "out(prefix + key);",
    "console.error('failed for', key);"
  ];

  for (const snippet of leaks) {
    const code = stripStringsAndComments(snippet);
    const caught = SINKS.some((sink) => new RegExp(`${sink.source}[^)]*\\bkey\\b`).test(code));
    assert.ok(caught, `the detector missed: ${snippet}`);
  }

  // And prose that merely mentions a key must not trip it, which is why the
  // strings are stripped first.
  const clean = ['out("Paste the key and press enter");', "out(`  current    ${describe()}`);"];
  for (const snippet of clean) {
    const code = stripStringsAndComments(snippet);
    const caught = SINKS.some((sink) => new RegExp(`${sink.source}[^)]*\\bkey\\b`).test(code));
    assert.equal(caught, false, `false positive on: ${snippet}`);
  }
});

function stripStringsAndComments(source) {
  // Interpolations are lifted out first and put back afterwards, so the text of
  // a template literal is stripped while its `${...}` survives.
  //
  // Without this, `` console.log(`the key is ${key}`) `` reduces to
  // `` console.log(``) `` and a genuine leak becomes invisible. The negative
  // control below caught exactly that.
  const interpolated = [];
  const marked = source.replace(/\$\{([^{}]*)\}/g, (_, expression) => {
    interpolated.push(expression);
    return `\u0000${interpolated.length - 1}\u0000`;
  });

  // The template pass has to be marker-aware: a plain replacement eats the
  // markers along with the literal text, and then there is nothing to restore.
  const stripped = marked
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, (match) => `\u0001${(match.match(/\u0000\d+\u0000/g) ?? []).join("")}\u0001`)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

  // Backticks and interpolations use different marker characters on purpose. An
  // earlier version tagged the template with a letter next to the index, and
  // the two interleaved so that no longer parsed as a pair: a template holding
  // one interpolation restored to a stray control character followed by the
  // expression, and the leak went undetected. Caught by the control below.
  return stripped
    .replace(/\u0001\u0001/g, "``")
    .replace(/\u0001([\s\S]*?)\u0001/g, (_, inner) => `\`${inner}\``)
    .replace(/\u0000(\d+)\u0000/g, (_, index) => interpolated[Number(index)]);
}

test("the health endpoint reports the key source, never the key", () => {
  const source = readFileSync("src/api/server.mjs", "utf8");
  assert.match(source, /keySource/);
  assert.ok(
    !/source:\s*config\.providers\.apiKey/.test(source),
    "the source field must never be assigned the value"
  );
});

// ---------------------------------------------------------------------------
// Provider configuration without a database
// ---------------------------------------------------------------------------

test("provider configuration resolves without a database credential", () => {
  // `npm run key:check` talks to OpenRouter and to nothing else. Its first run
  // failed on `POSTGRES_PASSWORD is not set` while holding a perfectly good
  // key — a coupling with no purpose, and the wrong way round: a key can be
  // diagnosed without a database, but a database cannot be diagnosed without
  // the rest of the stack.
  const config = configModule.loadProviderConfig({});

  assert.equal(config.providers.embedModel, "google/gemini-embedding-2");
  assert.equal(config.embedding.dimensions, 3072);
  assert.ok(config.embedding.batchSize > 0);
});

test("the provider section and the full config cannot drift", () => {
  // `loadConfig` spreads `providerSection`, so there is one definition. A field
  // added to one and not the other would be invisible in code review.
  //
  // Compared by shape rather than by value. `deepEqual` on the objects prints
  // every field on failure — which is how a real key reached a test log from
  // this very file.
  const section = configModule.loadProviderConfig(noKeyEnv());
  const full = loadConfig(noKeyEnv());

  assert.deepEqual(Object.keys(full.providers).sort(), Object.keys(section.providers).sort());
  assert.deepEqual(Object.keys(full.embedding).sort(), Object.keys(section.embedding).sort());

  // And the non-secret values must be identical, field by field.
  for (const key of Object.keys(section.providers)) {
    if (key === "apiKey" || key === "keySource") continue;
    assert.equal(full.providers[key], section.providers[key], `providers.${key} differs`);
  }
  for (const key of Object.keys(section.embedding)) {
    assert.equal(full.embedding[key], section.embedding[key], `embedding.${key} differs`);
  }
});
