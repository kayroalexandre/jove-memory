#!/usr/bin/env node
/**
 * Run the integration suite against a real PostgreSQL.
 *
 * Two things this wrapper does that a bare `node --test` does not:
 *
 * 1. Serial execution. Each test provisions a database with its own pool, and
 *    PostgreSQL's 100-connection default does not survive forty pools opening
 *    at once. The resulting failure looks like a database fault rather than a
 *    resource-management one, which is a miserable thing to debug.
 *
 * 2. A clear message when TEST_DATABASE_URL is absent. The suite refuses to
 *    run without a database rather than passing vacuously, and the error it
 *    raises is a module-load failure that reads like a syntax error.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.TEST_DATABASE_URL) {
  process.stderr.write(
    "test:integration needs a PostgreSQL to test against.\n\n" +
      "  docker compose up -d postgres\n" +
      "  TEST_DATABASE_URL=postgres://paradigm:<password>@127.0.0.1:5432/paradigm \\\n" +
      "    npm run test:integration\n\n" +
      "The suite deliberately refuses to run without a database. A green run " +
      "that tested nothing is worse than a red one.\n"
  );
  process.exit(1);
}

const testDir = join(ROOT, "test", "integration");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => join("test", "integration", name));

if (files.length === 0) {
  process.stderr.write("no integration tests found\n");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  { cwd: ROOT, stdio: "inherit", env: process.env }
);

process.exit(result.status ?? 1);
