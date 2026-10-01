/**
 * Workspace naming.
 *
 * A workspace name becomes a PostgreSQL database name, so the rules are the
 * database's rules, enforced in one place. Every name that reaches SQL goes
 * through `quoteIdentifier` — parameter binding cannot protect an identifier,
 * because identifiers are not values.
 */

/**
 * Valid unquoted PostgreSQL identifier.
 *
 * Deliberately strict: lowercase letters, digits and underscore, starting with
 * a letter. Anything else is quoted, and quoting a name that a user typed from
 * a typo is how you end up with `geos-acervo` and `geos_acervo` as two
 * different databases holding two half-copied memories.
 */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Names that would collide with the infrastructure's own databases. */
export const RESERVED = new Set(["postgres", "template0", "template1", "paradigm"]);

/**
 * The shared database holding entity edges that cross workspace boundaries.
 * It starts with an underscore, so it is exempt from SAFE_NAME. Declared here,
 * above the validators, because they reference it.
 */
export const SHARED_WORKSPACE = "_shared";

export function isSharedWorkspace(name) {
  return name === SHARED_WORKSPACE;
}

export function isValidWorkspaceName(name) {
  if (typeof name !== "string") return false;
  if (name !== SHARED_WORKSPACE && !SAFE_NAME.test(name)) return false;
  if (RESERVED.has(name)) return false;
  return true;
}

export class WorkspaceNameError extends Error {
  constructor(name, reason) {
    super(
      `Invalid workspace name ${JSON.stringify(String(name))}: ${reason}. ` +
        `Names must match ${SAFE_NAME} — lowercase, digits and underscores, ` +
        `starting with a letter, and must not be a reserved database name. ` +
        `See docs/OPERATIONS.md.`
    );
    this.name = "WorkspaceNameError";
    this.workspace = name;
  }
}

export function assertWorkspaceName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new WorkspaceNameError(name, "it must be a non-empty string");
  }
  if (name.length > 63) {
    throw new WorkspaceNameError(name, "it is longer than 63 characters");
  }
  // The shared database is infrastructure, not a user-named workspace, so it is
  // exempt from the leading-letter rule. Everything else must be a plain
  // unquoted identifier.
  if (name !== SHARED_WORKSPACE && !SAFE_NAME.test(name)) {
    throw new WorkspaceNameError(
      name,
      "it contains characters outside [a-z0-9_] or does not start with a letter"
    );
  }
  if (RESERVED.has(name)) {
    throw new WorkspaceNameError(name, `it is reserved (${[...RESERVED].join(", ")})`);
  }
  return name;
}

/**
 * Quote an identifier for interpolation into SQL.
 *
 * PostgreSQL has no bind parameter for identifiers, so a name that reaches
 * `CREATE DATABASE` or a schema-qualified table reference must be quoted.
 * `assertWorkspaceName` runs first, so by the time we get here the name is
 * already known-safe; quoting is the second line of defence, not the first.
 */
export function quoteIdentifier(name) {
  assertWorkspaceName(name);
  return `"${name}"`;
}
