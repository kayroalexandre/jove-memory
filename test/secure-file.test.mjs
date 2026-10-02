import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, chmodSync, existsSync, openSync, renameSync, unlinkSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secureDirectory, secureWriteFile, InsecureFileError } from "../scripts/lib/secure-file.mjs";
import { keyDirectoryCandidates, keyFileCandidates, loadConfig } from "../src/config.mjs";

/**
 * Writing a credential, and the failure that leaves one readable.
 *
 * The failure path here is the whole reason this file exists, and it is a
 * failure that has already happened once on this machine:
 * `~/.config/jove-memory` is owned by root, `mkdirSync` with `recursive: true`
 * succeeds silently because the directory already exists, and the `chmod` that
 * follows throws EPERM — after the user has pasted a key, and with the key
 * already in the process's memory.
 *
 * So two properties are pinned here:
 *
 *   - A directory that cannot be secured is refused *before* anything is
 *     read, and a fallback is offered.
 *   - A file whose mode came out loose is *deleted*, not left with a warning.
 *
 * Both are tested with injected failures, because reproducing them for real
 * needs root, or a filesystem without mode support. An untested failure path
 * is not a failure path.
 */

function scratch() {
  return mkdtempSync(join(tmpdir(), "jove-sec-"));
}

/**
 * The real filesystem operations, spread so a test can replace one of them.
 *
 * A spread of the module namespace rather than a hand-written list, so a
 * function added to `secure-file.mjs` is available here without editing this
 * file — and a test that forgets to pass it fails loudly instead of silently
 * exercising a no-op.
 */
const realOps = { ...fs };

const KEY = ["sk", "or", "v1", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
const mode = (path) => statSync(path).mode & 0o777;

// ---------------------------------------------------------------------------
// Directory selection
// ---------------------------------------------------------------------------

test("a directory we own is accepted", () => {
  const dir = scratch();
  const verdict = secureDirectory(join(dir, "secrets"));

  assert.equal(verdict.usable, true, verdict.reason);
  assert.equal(mode(join(dir, "secrets")), 0o700);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory owned by another user is refused, and the reason names the owner", () => {
  // Simulated rather than probed at a real path. The original version pointed
  // at `/home/kayro/.config/jove-memory`, which is what failed here — and which
  // does not exist on a CI runner at all, so the same test asserted
  // "cannot create it" in CI and "owned by uid 0" on this machine. A test
  // whose assertion depends on whose machine it runs on is a test about the
  // machine.
  const dir = scratch();
  const target = join(dir, "secrets");
  mkdirSync(target, { recursive: true });

  const verdict = secureDirectory(target, {
    ...realOps,
    statSync: (path) => ({ ...realOps.statSync(path), uid: process.getuid() + 4242 })
  });

  assert.equal(verdict.usable, false);
  assert.equal(verdict.owned, false);
  assert.match(
    verdict.reason,
    /owned by uid \d+, not by this user/,
    "the reason must name the owner — 'chmod failed' sends the reader to the wrong fix"
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a real unusable directory is refused, whatever the reason", () => {
  // The machine-dependent half, kept deliberately weak. The property that
  // matters is "refused, and says why", not which of the several reasons
  // applies on the day. Asserting a specific message here is what made the
  // previous version of this test pass on one machine and fail on another.
  const dir = scratch();
  const blocker = join(dir, "a-file");
  writeFileSync(blocker, "not a directory");

  const verdict = secureDirectory(join(blocker, "secrets"));
  assert.equal(verdict.usable, false);
  assert.ok(verdict.reason && verdict.reason.length > 10, `unhelpful reason: ${verdict.reason}`);
  rmSync(dir, { recursive: true, force: true });
});

test("a directory that cannot be created is refused, not thrown from", () => {
  // The parent is a regular file, so mkdir fails immediately with ENOTDIR.
  //
  // An earlier version used a path under /proc, and `mkdir` on that filesystem
  // *hangs* in this environment rather than returning ENOENT. A fixture that
  // hangs is worse than a fixture that fails: the whole file times out and the
  // other twenty tests in it stop reporting.
  const dir = scratch();
  const blocker = join(dir, "a-file");
  writeFileSync(blocker, "not a directory");

  const verdict = secureDirectory(join(blocker, "secrets"));
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason, /cannot create|does not exist/);
  rmSync(dir, { recursive: true, force: true });
});

test("a chmod that throws on an already-private directory is not a failure", () => {
  // Re-chmod'ing a directory that is already 700 can fail on some mounts, and
  // that is not a reason to refuse: the property we care about holds.
  const dir = scratch();
  const target = join(dir, "secrets");
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o700);

  const verdict = secureDirectory(target, {
    ...realOps,
    chmodSync: () => {
      throw new Error("EPERM");
    }
  });

  assert.equal(verdict.usable, true, "already 700 and ours — the end state is what matters");
  rmSync(dir, { recursive: true, force: true });
});

test("a directory that stays world-readable is refused", () => {
  // A filesystem that silently ignores mode bits. The directory looks fine
  // until the mode is read back, which is the only way to know.
  const dir = scratch();
  mkdirSync(join(dir, "secrets"), { recursive: true });

  const verdict = secureDirectory(join(dir, "secrets"), {
    mkdirSync,
    statSync,
    chmodSync: () => {} // succeeds, changes nothing
  });

  assert.equal(verdict.usable, false);
  assert.match(verdict.reason, /mode is 755|other accounts can read/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test("a key file is written 600, in a 700 directory", () => {
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  const written = secureWriteFile(file, KEY);

  assert.equal(written.mode & 0o777, 0o600);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.equal(readFileSync(file, "utf8"), KEY, "and no trailing newline to clean up later");
  rmSync(dir, { recursive: true, force: true });
});

test("the file is created 600, not chmod'ed to it afterwards", () => {
  // Created 644 and chmod'ed, there is a window where another account can read
  // a credential. The mode argument on open is the only thing that closes it.
  const dir = scratch();
  secureDirectory(dir);

  let createMode = null;
  const file = join(dir, "openrouter.key");
  secureWriteFile(file, KEY, {
    ...realOps,
    openSync: (path, flags, mode) => {
      createMode = mode;
      return realOps.openSync(path, flags, mode);
    }
  });

  assert.equal(createMode, 0o600, "the mode must be given at creation");
  rmSync(dir, { recursive: true, force: true });
});

test("overwriting an existing key leaves it 600 and complete", () => {
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  secureWriteFile(file, KEY);
  secureWriteFile(file, `${KEY}-rotated`);

  assert.equal(readFileSync(file, "utf8"), `${KEY}-rotated`);
  assert.equal(mode(file), 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("the default path writes at all", () => {
  // Added because it was missing. Every other test here injects its own `ops`,
  // so a module whose *default* operations were incomplete passed a green suite
  // while being unable to write a file. `realOps` once left out `openSync`, and
  // every real call threw `ops.openSync is not a function`.
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  const written = secureWriteFile(file, KEY);

  assert.equal(readFileSync(file, "utf8"), KEY, "the real filesystem path must work");
  assert.equal(written.mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("every operation this module uses is overridable", () => {
  // The same defect, asserted structurally. A filesystem call that bypasses
  // `ops` cannot be replaced by a test, so its failure path is untestable and
  // therefore unguarded.
  const source = readFileSync("scripts/lib/secure-file.mjs", "utf8");
  const body = source.slice(source.indexOf("export function secureWriteFile"));
  const direct = [...body.matchAll(/(?<![.\w])(chmodSync|openSync|renameSync|unlinkSync|statSync|mkdirSync)\s*\(/g)].map(
    (m) => m[1]
  );

  assert.deepEqual(
    direct.filter((name) => name !== "realOps"),
    [],
    `these run outside ops and cannot be tested: ${[...new Set(direct)].join(", ")}`
  );
});

test("no temporary file is left behind", () => {
  const dir = scratch();
  secureDirectory(dir);
  secureWriteFile(join(dir, "openrouter.key"), KEY);

  assert.deepEqual(readdirSync(dir), ["openrouter.key"], "the temp file must be renamed, not left");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The failure that matters
// ---------------------------------------------------------------------------

test("a file left world-readable is DELETED, not reported and left", () => {
  // The case this whole module exists for. A chmod that fails silently leaves
  // a credential every account on the machine can read, and a process that
  // exits 0 saying "stored" is worse than one that says nothing.
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  assert.throws(
    () =>
      secureWriteFile(file, KEY, {
        ...realOps,
        chmodSync: () => {}, // silently ignored, as on a mode-less filesystem
        statSync: (path) => {
          const info = realOps.statSync(path);
          // Report the mode a filesystem ignoring chmod would leave.
          return { ...info, mode: info.mode | 0o044 };
        }
      }),
    (err) => {
      assert.ok(err instanceof InsecureFileError);
      assert.match(err.message, /Refusing to leave a credential/);
      assert.match(err.message, /has been deleted/);
      return true;
    }
  );

  assert.equal(existsSync(file), false, "the readable credential must not survive the failure");
  rmSync(dir, { recursive: true, force: true });
});

test("a failure to delete is reported as such, not hidden behind the original error", () => {
  // If the file cannot be removed, saying only "refusing" would send the
  // operator looking for a file that is still there.
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  assert.throws(
    () =>
      secureWriteFile(file, KEY, {
        ...realOps,
        chmodSync: () => {},
        statSync: (path) => ({ ...realOps.statSync(path), mode: 0o644 }),
        unlinkSync: () => {
          throw new Error("EBUSY");
        }
      }),
    /could NOT be deleted/
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a temp file is removed when the rename fails", () => {
  const dir = scratch();
  secureDirectory(dir);
  const file = join(dir, "openrouter.key");

  assert.throws(
    () =>
      secureWriteFile(file, KEY, {
        ...realOps,
        openSync: (p, f, m) => realOps.openSync(p, f, m),
        renameSync: () => {
          throw new Error("EXDEV cross-device link");
        }
      }),
    /EXDEV/
  );

  // A truncated key left in a temp file is a key that looks valid.
  const leftovers = readdirSync(dir);
  assert.deepEqual(leftovers, [], `temp files must be cleaned up, found: ${leftovers.join(", ")}`);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// One source of truth for the paths
// ---------------------------------------------------------------------------

test("the setup script and the config module agree on where a key may live", () => {
  // They cannot drift. The first version of the script hardcoded
  // ~/.config/jove-memory while the config module looked in two other places,
  // so a key written by one could be invisible to the other.
  const source = readFileSync("scripts/set-provider-key.mjs", "utf8");
  assert.match(
    source,
    /import \{ keyDirectoryCandidates \} from "\.\.\/src\/config\.mjs"/,
    "the script must import the candidate list rather than define its own"
  );

  // No hardcoded key path. The previous version of this test simply asserted
  // the string `.config/jove-memory` was absent, which is true and useless:
  // the real defect was a *duplicated* path list, and a duplicated list is not
  // a duplicated literal — it is the same directory assembled twice in two
  // files. The import above is the assertion that matters.
  assert.ok(
    !/join\([^)]*"\.(config|local)[^)]*jove-memory/.test(source),
    "the script must not assemble a key path itself"
  );
});

test("at least one fallback directory is usable, whatever the machine looks like", () => {
  // The property that matters: the list is never a dead end. On this machine
  // `~/.config/jove-memory` is root-owned, which is exactly why the fallbacks
  // exist.
  //
  // Run against a scratch HOME. The earlier version probed the real home
  // directory, which meant the suite *created* directories in it as a side
  // effect, and its result depended on whose account ran it.
  const home = scratch();
  const candidates = keyDirectoryCandidates({ HOME: home });
  assert.ok(candidates.length >= 2, "there must be a fallback at all");

  const usable = candidates.filter((dir) => secureDirectory(dir).usable);
  assert.ok(usable.length > 0, `no usable candidate among: ${candidates.join(", ")}`);
  assert.ok(
    candidates.every((dir) => dir.startsWith(home)),
    "and every candidate is under the home directory, never the project"
  );
  rmSync(home, { recursive: true, force: true });
});

test("JOVE_SECRETS_DIR replaces the list rather than joining it", () => {
  // Honoured or refused, never merged. A key in a place the operator did not
  // ask for is its own kind of surprise, and health reports the path.
  const candidates = keyDirectoryCandidates({ JOVE_SECRETS_DIR: "/somewhere/explicit" });
  assert.deepEqual(candidates, ["/somewhere/explicit"]);
});

test("the config module looks in every directory the script might write to", () => {
  const dirs = keyDirectoryCandidates({});
  const files = keyFileCandidates({});

  for (const dir of dirs) {
    assert.ok(
      files.includes(join(dir, "openrouter.key")),
      `${dir} is a candidate to write to but not to read from`
    );
  }
});

test("a key in a fallback directory is found", () => {
  // The end-to-end property: the script writes somewhere, the config reads it,
  // and nothing in between has to know which somewhere.
  const dir = scratch();
  const chosen = join(dir, "jove-memory");
  secureDirectory(chosen);
  secureWriteFile(join(chosen, "openrouter.key"), KEY);

  const config = loadConfig({
    POSTGRES_PASSWORD: "unused",
    JOVE_SECRETS_DIR: chosen
  });

  assert.equal(config.providers.apiKey, KEY);
  assert.equal(config.providers.keySource, `file:${join(chosen, "openrouter.key")}`);
  rmSync(dir, { recursive: true, force: true });
});

