#!/usr/bin/env node
/**
 * Store the OpenRouter key, without ever putting it in the repository, in a
 * shell history, or in a terminal scrollback — and without ever putting it in
 * a place this machine cannot keep private.
 *
 * Order of operations, and the order is the design:
 *
 *   1. Pick a directory that can actually be secured. Before anything is read
 *      from the terminal. A setup script that asks for a secret and then fails
 *      to save it has made the user paste their key into a void.
 *   2. Read the key from the TTY with echo off.
 *   3. Write it, then verify the mode, and delete it if the mode is loose.
 *
 * Step 1 exists because of a real failure. `~/.config/jove-memory` on this
 * machine is owned by root: `mkdir` with `recursive: true` silently succeeds
 * because the directory already exists, the `chmod` that follows throws EPERM,
 * and the user is left re-pasting a key. So the directory is now chosen by
 * asking whether we own it and whether we can make it private, with fallbacks.
 *
 * Step 3 is in `lib/secure-file.mjs`, and its own comment explains why a chmod
 * that fails silently is worse than one that throws.
 *
 * What it never does: print the key, print any part of it, or contact the
 * network. Verifying the key is `npm run key:check`, so that storing stays
 * free, offline and instant, and a failed check is unambiguously about the key
 * rather than about the act of saving it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { keyDirectoryCandidates } from "../src/config.mjs";
import { secureDirectory, secureWriteFile, InsecureFileError } from "./lib/secure-file.mjs";

/**
 * The shape of an OpenRouter key.
 *
 * Assembled from fragments at runtime rather than written literally, so this
 * file contains no string matching the repository's own secret-scan rules. The
 * scanner would otherwise block the commit, and the correct fix is to not write
 * the literal — the same reasoning behind the fixture in
 * test/redaction.test.mjs.
 */
const PREFIX = ["sk", "or", "v1"].join("-");
const KEY_SHAPE = new RegExp(`^${PREFIX}-[A-Za-z0-9_-]{16,}$`);
const FILE_NAME = "openrouter.key";

function out(text) {
  process.stdout.write(text);
}

/** Read one line from the TTY with echo disabled. */
function promptHidden(prompt) {
  const result = spawnSync(
    "bash",
    ["-c", 'IFS= read -rs -p "$1" _jove_key; printf "%s" "$_jove_key"', "bash", prompt],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
  );

  if (result.error || result.status !== 0) {
    out("\nCould not read from the terminal. Run this directly in a shell, not through a pipe.\n");
    process.exit(1);
  }
  return result.stdout.trim();
}

function validate(key) {
  if (!key) return "the value was empty — nothing was pasted";
  if (!KEY_SHAPE.test(key)) {
    // Says what is wrong without echoing what was typed.
    return (
      `that does not look like an OpenRouter key. Expected something starting ` +
      `with ${PREFIX}- and at least 20 characters.`
    );
  }
  return null;
}

/**
 * Choose a directory that can hold a credential privately.
 *
 * `explicit` means the operator set `JOVE_SECRETS_DIR`. In that case the choice
 * is honoured or refused — silently storing the key somewhere they did not ask
 * for is its own kind of surprise, and the health endpoint reports the path, so
 * a key in an unexpected place is visible but late.
 */
function chooseDirectory() {
  const candidates = keyDirectoryCandidates();
  const explicit = Boolean(process.env.JOVE_SECRETS_DIR);
  const rejected = [];

  for (const dir of candidates) {
    const verdict = secureDirectory(dir);
    if (verdict.usable) {
      return { dir, rejected, explicit };
    }
    rejected.push({ dir, reason: verdict.reason });
    if (explicit) break;
  }

  reportNoUsableDirectory(rejected, explicit);
}

function reportNoUsableDirectory(rejected, explicit) {
  out("\n  No directory here can hold a credential privately.\n\n");
  for (const { dir, reason } of rejected) {
    out(`    ${dir}\n      ${reason}\n`);
  }

  if (explicit) {
    out(
      "  JOVE_SECRETS_DIR is set, so no fallback was tried. Unset it to use a\n" +
        "  default, or point it at a directory you own.\n"
    );
  } else {
    out(
      "  Every candidate is owned by another account or sits on a filesystem\n" +
        "  that does not support permissions. Either give one of them to this\n" +
        "  user:\n\n" +
        "    sudo chown $(id -u):$(id -g) ~/.config/jove-memory\n\n" +
        "  or point JOVE_SECRETS_DIR at a directory you own, on a filesystem\n" +
        "  that supports modes:\n\n" +
        "    export JOVE_SECRETS_DIR=~/.local/share/jove-memory\n"
    );
  }
  process.exit(1);
}

function describeExisting(dir) {
  const file = join(dir, FILE_NAME);
  if (!existsSync(file)) return "not set";
  try {
    const info = statSync(file);
    const contents = readFileSync(file, "utf8").trim();
    const shape = KEY_SHAPE.test(contents)
      ? "well-formed"
      : "does NOT match the expected shape";
    return `${contents.length} characters, ${shape}, mode ${(info.mode & 0o777).toString(8)}`;
  } catch (err) {
    return `unreadable: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------

const { dir, rejected, explicit } = chooseDirectory();

out("jove-memory — store the OpenRouter key\n\n");
out(`  location   ${join(dir, FILE_NAME)}\n`);
if (rejected.length > 0) {
  // Named, because a path that differs from the one the user expected is
  // exactly the thing to notice while they still can.
  out(
    `  note       ${rejected.length} earlier candidate(s) could not be used ` +
      `privately; the first is shown\n` +
      `              ${rejected[0].dir}\n` +
      `              ${rejected[0].reason}\n`
  );
  if (explicit) out("              JOVE_SECRETS_DIR is set, so there is no fallback.\n");
}
out("\n");
out("  the key is read with echo off and is never printed, logged, or\n");
out("  written inside the repository. Nothing is sent over the network.\n\n");
out(`  current    ${describeExisting(dir)}\n\n`);
out("  Paste the key and press enter (nothing will be shown): ");

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const key = promptHidden("");
  out("\n");

  const problem = validate(key);
  if (problem) {
    out(`  Not stored: ${problem}.\n`);
    if (attempt < 3) out("  Try again: ");
    continue;
  }

  try {
    const written = secureWriteFile(join(dir, FILE_NAME), key);
    out(`\n  Stored. ${describeExisting(dir)}\n`);
    out(`  ${written.path}\n`);
    out(`  mode ${(written.mode & 0o777).toString(8)}, in a 700 directory, outside the repository.\n\n`);

    // `compose.yml` mounts a directory, and it has to be the same one the key
    // actually went to. When they differ — the normal case when the preferred
    // location is unusable — the export is spelled out here, rather than left
    // for the user to infer from a health message.
    const composeDefault = process.env.JOVE_SECRETS_DIR ?? join(homedir(), ".config", "jove-memory");
    if (dir !== composeDefault) {
      out("  The container mounts a different path by default, so it will not see\n");
      out("  this file yet. To let it:\n\n");
      out(`    export JOVE_SECRETS_DIR=${dir}\n\n`);
      out("  `npm run key:check` runs on this host and needs neither.\n\n");
    }

    out("  Next:\n");
    out("    npm run key:check      verifies it against the live API\n");
    out("\n");
    process.exit(0);
  } catch (err) {
    if (err instanceof InsecureFileError) {
      out(`\n  NOT stored, and nothing was left behind.\n\n  ${err.message}\n\n`);
      process.exit(1);
    }
    out(`\n  Not stored: ${err.message}\n\n`);
    out("  The previous value, if any, is unchanged.\n");
    process.exit(1);
  }
}

// Left whatever was there before, untouched. A failed save does not clear a
// working key, which is the one outcome worse than the one already present.
out("\n  Three failed attempts. The previous value, if any, is unchanged.\n");
process.exit(1);
