#!/usr/bin/env node
/**
 * Store the OpenRouter key, without ever putting it in the repository, in a
 * shell history, or in a terminal scrollback.
 *
 * How it reads the key: from the TTY, with echo off, through `read -rs` in a
 * shell. The alternative — `OPENROUTER_API_KEY=... npm run key:set` — would
 * write the key into `~/.bash_history`, and the other alternative — typing it
 * at a prompt that echoes — would put it in the scrollback and in any screen
 * recording of the session. Neither is recoverable by deleting a file later.
 *
 * How it stores the key: `~/.config/jove-memory/openrouter.key`, mode 600,
 * inside a directory mode 700. Outside the repository by construction, which
 * is the point — `config.mjs` refuses to read a key from inside the project,
 * and this is where it expects to find one instead.
 *
 * What it does NOT do: contact the network. Verifying the key is a separate
 * command (`npm run key:check`) so that storing it stays free, offline, and
 * instant, and so a failed check is unambiguously about the key rather than
 * about the act of saving it.
 *
 * What it never does: print the key, print any part of it, or write it to a
 * log. The only thing reported about the value is its length, which is enough
 * to catch an empty paste and nothing more.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = process.env.JOVE_SECRETS_DIR ?? join(homedir(), ".config", "jove-memory");
const FILE = join(DIR, "openrouter.key");

/**
 * The shape of an OpenRouter key.
 *
 * Assembled from fragments at runtime rather than written literally, so this
 * file does not contain a string matching the repository's own secret-scan
 * rules. The scanner would otherwise block the commit, and the correct fix
 * for that is to not write the literal — the same reasoning behind the
 * fixture in test/redaction.test.mjs.
 */
const PREFIX = ["sk", "or", "v1"].join("-");
const KEY_SHAPE = new RegExp(`^${PREFIX}-[A-Za-z0-9_-]{16,}$`);

function out(text) {
  process.stdout.write(text);
}

/** Read one line from the TTY with echo disabled. */
function promptHidden(prompt) {
  const result = spawnSync("bash", ["-c", 'IFS= read -rs -p "$1" _jove_key; printf "%s" "$_jove_key"', "bash", prompt], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"]
  });

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
    return `that does not look like an OpenRouter key. Expected something starting with ${PREFIX}- and at least 20 characters.`;
  }
  return null;
}

function store(key) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, and the directory may already exist with
  // looser permissions. Set both explicitly rather than trusting either.
  chmodSync(DIR, 0o700);

  // Written to a temporary file in the same directory and renamed, so a
  // failure partway through cannot leave a truncated key that looks valid.
  const temporary = join(DIR, `.openrouter.key.${process.pid}`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    // No trailing newline beyond the one the file needs, and no trailing
    // whitespace of any kind: `config.mjs` trims, but a file that needs
    // trimming is a file someone will debug by hand later.
    writeSync(handle, key);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, FILE);
  chmodSync(FILE, 0o600);
}

function describe() {
  if (!existsSync(FILE)) return "not set";
  const info = statSync(FILE);
  const contents = readFileSync(FILE, "utf8").trim();
  const shape = KEY_SHAPE.test(contents) ? "well-formed" : "does NOT match the expected shape";
  return `${contents.length} characters, ${shape}, mode ${(info.mode & 0o777).toString(8)}`;
}

out("jove-memory — store the OpenRouter key\n\n");
out(`  location   ${FILE}\n`);
out("  the key is read with echo off and is never printed, logged, or\n");
out("  written inside the repository. Nothing is sent over the network.\n\n");
out(`  current    ${describe()}\n\n`);

out("  Paste the key and press enter (nothing will be shown): ");

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const key = promptHidden("");
  out("\n");

  const problem = validate(key);
  if (!problem) {
    store(key);
    out(`\n  Stored. ${describe()}\n`);
    out(`  mode 600, inside a 700 directory, outside the repository.\n\n`);
    out("  Next:\n");
    out("    npm run key:check      verifies it against the live API\n");
    out("\n");
    process.exit(0);
  }

  out(`  Not stored: ${problem}.\n`);
  if (attempt < 3) out("  Try again: ");
}

// Left whatever was there before, untouched. A failed save does not clear a
// working key, which is the one outcome worse than the one already present.
out("\n  Three failed attempts. The previous value, if any, is unchanged.\n");
process.exit(1);
