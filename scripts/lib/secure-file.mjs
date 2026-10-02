/**
 * Writing a file whose permissions matter.
 *
 * Exists because the ordering is the whole point, and getting the ordering
 * wrong writes a credential other users can read:
 *
 *   1. write to a temporary file in the same directory, mode 600 from the start
 *   2. rename over the target — atomic, so an interrupted save cannot leave a
 *      truncated key that looks valid
 *   3. tighten the directory to 700
 *   4. **verify the resulting mode**
 *   5. if the mode is loose, delete the file and fail
 *
 * Step 5 is the one that is easy to omit and the one that matters. A `chmod`
 * that fails silently — a filesystem mounted without permission support, a
 * directory owned by root, a container running as a different user — leaves a
 * key that any account on the machine can read, and the process exits 0 having
 * reported success. That has happened: the first version of `key:set` did
 * exactly that, on a directory owned by root, and only surfaced as a stack
 * trace from a chmod that threw *after* the file existed.
 *
 * `ops` is injectable so the failure path is testable. The failure only
 * happens under conditions that are awkward to reproduce for real — an
 * unwritable directory owned by another user, a filesystem that ignores mode
 * bits — and an untested failure path is not a failure path.
 */

import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** The modes this module is willing to leave behind. */
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class InsecureFileError extends Error {
  constructor(path, mode) {
    super(
      `Refusing to leave a credential at ${path}: it is mode ${mode.toString(8)}, ` +
        `and this machine did not honour the request for ${PRIVATE_FILE.toString(8)}.\n` +
        "  The file has been deleted rather than left readable by other accounts.\n" +
        "  Usual causes: the directory is owned by another user, or the\n" +
        "  filesystem is mounted without permission support.\n" +
        "  Point JOVE_SECRETS_DIR at a directory you own, on a filesystem that\n" +
        "  supports modes, and run this again."
    );
    this.name = "InsecureFileError";
    this.path = path;
    this.mode = mode;
  }
}

/**
 * The real filesystem, as one object.
 *
 * Every filesystem call in this module goes through `ops` rather than the
 * imported binding, so a test can replace one of them. That is not
 * testability for its own sake: the failure this module exists to handle only
 * occurs under conditions that are awkward to reproduce for real — a
 * directory owned by another user, a filesystem that ignores mode bits — and
 * those are exactly the cases that must be pinned.
 *
 * An earlier version left `openSync` out of this object, so the default path
 * threw `ops.openSync is not a function` on every write. The tests that
 * exercised the interesting failures all injected their own ops and passed,
 * which is how a module that cannot write a file at all came to have a
 * green suite.
 */
const realOps = { chmodSync, mkdirSync, statSync, openSync, renameSync, unlinkSync };

/**
 * Create `dir` if needed, and report whether it ended up private and ours.
 *
 * Returns a verdict rather than throwing, because the caller has a list of
 * candidates and needs to move to the next one. The reasons are kept for the
 * error message a user eventually sees.
 */
export function secureDirectory(dir, ops = realOps) {
  const reasons = [];
  let info = tryStat(dir, ops);

  if (info === null) {
    try {
      ops.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    } catch (err) {
      return { usable: false, reason: `cannot create it: ${err.message}`, mode: null, owned: false };
    }
    info = tryStat(dir, ops);
  }

  if (info === null) {
    return { usable: false, reason: "it does not exist and could not be created", mode: null, owned: false };
  }

  const owned = typeof process.getuid === "function" ? info.uid === process.getuid() : true;

  try {
    ops.chmodSync(dir, PRIVATE_DIR);
  } catch (err) {
    // Not fatal by itself: a directory that is already 700 and merely refuses
    // to be chmod'ed again is fine. A directory that is not 700 is not.
    reasons.push(`cannot chmod: ${err.message}`);
  }

  const after = tryStat(dir, ops);
  const mode = after?.mode ?? info.mode;
  const modeOk = (mode & 0o077) === 0;

  if (!owned) {
    return {
      usable: false,
      reason: `it is owned by uid ${info.uid}, not by this user (${process.getuid?.() ?? "?"})`,
      mode,
      owned: false
    };
  }
  if (!modeOk) {
    return {
      usable: false,
      reason: reasons[0] ?? `its mode is ${mode.toString(8)}, which other accounts can read`,
      mode,
      owned: true
    };
  }

  return { usable: true, reason: null, mode, owned: true };
}

/**
 * Write `contents` to `path` privately, or leave nothing behind.
 *
 * Returns `{ path, mode }` on success. Throws `InsecureFileError` and leaves
 * no file if the permissions cannot be guaranteed.
 */
export function secureWriteFile(path, contents, ops = realOps) {
  const dir = dirname(path);
  const temporary = `${path}.${process.pid}.tmp`;

  // 0o600 at creation rather than chmod after: a file created with 0o644 is
  // readable by other accounts for the entire window between create and
  // chmod, and that window is the whole reason to use the mode argument.
  const handle = ops.openSync(temporary, "wx", PRIVATE_FILE);
  try {
    writeSync(handle, contents);
  } finally {
    closeSync(handle);
  }

  try {
    ops.renameSync(temporary, path);
  } catch (err) {
    try {
      ops.unlinkSync(temporary);
    } catch {
      // Nothing more to do; the original error is the useful one.
    }
    throw err;
  }

  // Renamed into place before the mode is checked, so a concurrent reader sees
  // either the old file or the new one, never a partial one.
  try {
    ops.chmodSync(path, PRIVATE_FILE);
  } catch {
    // Verified below. A chmod that throws is not by itself the failure; a
    // file that is still readable afterwards is.
  }

  const info = tryStat(path, ops);
  if (!info) {
    throw new Error(`The file at ${path} vanished immediately after being written.`);
  }

  if ((info.mode & 0o077) !== 0) {
    // Delete before throwing. Leaving a world-readable credential in place and
    // reporting an error is the worst of the two outcomes: the operator has to
    // find and remove it, and might not.
    try {
      ops.unlinkSync(path);
    } catch {
      // Report the original problem, and say the file may remain.
      throw new InsecureFileError(`${path} (and it could NOT be deleted)`, info.mode);
    }
    throw new InsecureFileError(path, info.mode);
  }

  return { path, mode: info.mode };
}

function tryStat(path, ops) {
  try {
    return ops.statSync(path);
  } catch {
    return null;
  }
}
