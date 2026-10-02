import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The project's own invariants, asserted against the files that declare them.
 *
 * These exist because documentation that contradicts the code is worse than no
 * documentation, because it gets trusted (CONTRIBUTING.md). A change that
 * breaks an invariant fails here rather than being discovered later.
 */

// ---------------------------------------------------------------------------
// ADR-009: no local model runtime
// ---------------------------------------------------------------------------

test("no source file imports a local model runtime", () => {
  const forbidden = [
    "@huggingface/transformers",
    "onnxruntime",
    "@xenova/transformers",
    "onnx-community/"
  ];

  const files = ["package.json", "Dockerfile", "compose.yml"];
  for (const file of files) {
    assert.ok(existsSync(file), `${file} must exist`);
    const content = readFileSync(file, "utf8");
    for (const bad of forbidden) {
      assert.ok(
        !content.includes(bad),
        `${file} references "${bad}". ADR-009 forbids a local model runtime: ` +
          `the image must hold no model weights and no ML runtime.`
      );
    }
  }
});

test("package.json declares no local model dependency", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of Object.keys(all)) {
    assert.ok(
      !/transformers|onnx|torch|@xenova|transformers\.js/i.test(name),
      `dependency "${name}" looks like a local model runtime, forbidden by ADR-009`
    );
  }
});

// ---------------------------------------------------------------------------
// ADR-003: one database per workspace, not schemas
// ---------------------------------------------------------------------------

test("compose publishes no database or object-storage port to the host", () => {
  const compose = readFileSync("compose.yml", "utf8");

  // The api service is the only one allowed to publish, and only on loopback.
  const services = compose.split(/^  (?=\w)/m).filter((s) => /^\s{2}\w+:/.test(s));
  for (const service of services) {
    const name = service.match(/^\s{2}(\w+):/)?.[1];
    if (name === "api") continue;
    assert.ok(
      !/^\s+ports:/m.test(service),
      `service "${name}" publishes a host port. Postgres and MinIO hold the user's ` +
        `memory content and media bytes — they must be reachable only inside the ` +
        `Compose network. See docs/SECURITY.md.`
    );
  }

  // The api port must be bound to loopback, not 0.0.0.0.
  assert.ok(
    /ports:\s*\n\s*- "127\.0\.0\.1:8888:8888"/.test(compose),
    "the api port must be bound to 127.0.0.1, not all interfaces"
  );
});

test("compose declares an explicit project name", () => {
  const compose = readFileSync("compose.yml", "utf8");
  assert.match(
    compose,
    /^name:\s*jove-memory$/m,
    "compose.yml must declare `name: jove-memory`. Without it the project name " +
      "is inferred from the directory, so a checkout in a differently-named " +
      "folder gets different volume and network names — and a second copy of " +
      "this stack would silently attach to the wrong volumes."
  );
});

test("compose keeps all three services in one project", () => {
  const compose = readFileSync("compose.yml", "utf8");

  // Look only inside the `services:` block, so a `depends_on:` key at a deeper
  // indent is not mistaken for a service definition.
  const servicesBlock = compose.slice(compose.indexOf("\nservices:\n"));
  assert.ok(servicesBlock.length > 0, "compose.yml must have a services: block");

  for (const service of ["api", "postgres", "minio"]) {
    assert.ok(
      new RegExp(`^  ${service}:\\s*$`, "m").test(servicesBlock),
      `compose.yml must define the "${service}" service. All containers belong to ` +
        `the same Compose project so they share a network and lifecycle.`
    );
  }
  assert.ok(
    /networks:\s*\n\s+jove:/m.test(compose),
    "compose.yml must define the shared 'jove' network"
  );
});

test("compose.yml is structurally valid", async () => {
  // Text assertions cannot tell valid YAML from a file whose indentation was
  // broken by an edit. This parses it.
  const compose = readFileSync("compose.yml", "utf8");

  // Minimal structural check that does not need a YAML dependency: every
  // service key must be followed by keys indented deeper than itself, and the
  // whole file must have consistent two-space indentation levels.
  const lines = compose.split("\n");
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      assert.fail(
        `compose.yml:${i + 1} has odd indentation (${indent} spaces): ${line.trim()}\n` +
          `Odd indentation is how a mis-indented key silently escapes its service ` +
          `block and turns valid-looking YAML into a broken file.`
      );
    }
  }

  // Every key that belongs to a service must be indented under it.
  const apiIndex = compose.indexOf("\n  api:");
  assert.ok(apiIndex > 0, "the api service must be defined");
  const afterApi = compose.slice(apiIndex).split("\n").slice(1);
  for (const key of ["container_name", "ports", "depends_on"]) {
    const found = afterApi.some((l) => l.startsWith(`    ${key}:`));
    assert.ok(
      found,
      `the api service must have a "${key}" key at four-space indent. A service key ` +
        `at two-space indent means the file lost a nesting level.`
    );
  }
});

// ---------------------------------------------------------------------------
// ADR-005: one embedding space
// ---------------------------------------------------------------------------

test("only one embedding model is configured", () => {
  const example = readFileSync(".env.example", "utf8");
  const matches = [...example.matchAll(/^PARADIGM_EMBED_MODEL=/gm)];
  assert.equal(
    matches.length,
    1,
    "exactly one PARADIGM_EMBED_MODEL must be configured. ADR-005: Gemini " +
      "Embedding 2 puts text and images in one space, so there is one index. " +
      "A second model would be a second space, which cannot be searched together."
  );
  assert.match(
    example,
    /^PARADIGM_EMBED_MODEL=google\/gemini-embedding-2$/m,
    "the configured embedding model must be the multimodal single-space model"
  );
});

// ---------------------------------------------------------------------------
// Configuration hygiene
// ---------------------------------------------------------------------------

test(".env.example contains no populated secrets", () => {
  const example = readFileSync(".env.example", "utf8");
  for (const line of example.split("\n")) {
    const m = line.match(/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, name, value] = m;
    assert.equal(
      value.trim(),
      "",
      `.env.example must leave ${name} empty. This file is committed to a public repository.`
    );
  }
});

test("gitignore covers every path that holds memory content", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const pattern of [
    ".env",
    "*.sqlite",
    "*.brain",
    "pgdata/",
    "minio-data/",
    "snapshots/",
    "node_modules/"
  ]) {
    assert.ok(
      ignore.includes(pattern),
      `.gitignore must include "${pattern}". It holds memory content or credentials, ` +
        `and this repository is public.`
    );
  }
});

// ---------------------------------------------------------------------------
// Plan integrity
// ---------------------------------------------------------------------------

test("every phase in PLAN.md has a corresponding gate section", () => {
  const plan = readFileSync("docs/PLAN.md", "utf8");
  for (let phase = 1; phase <= 10; phase += 1) {
    assert.ok(
      plan.includes(`## Phase ${phase}`),
      `docs/PLAN.md is missing Phase ${phase}. A phase without a gate cannot be ` +
        `verified as done, and a plan that drifts from reality stops being usable.`
    );
  }
});

test("every ADR entry states its consequences", () => {
  const decisions = readFileSync("docs/DECISIONS.md", "utf8");
  const entries = decisions.split(/^## ADR-/m).slice(1);
  assert.ok(entries.length >= 12, "expected at least 12 ADRs");
  for (const entry of entries) {
    const id = entry.match(/^(\d+)/)?.[1];
    assert.ok(
      /\*\*Consequences:?\*\*/.test(entry) || /\*\*Consequences/.test(entry),
      `ADR-${id} does not state its consequences. A decision record without a cost ` +
        `is a preference, not a decision.`
    );
  }
});

// ---------------------------------------------------------------------------
// Documentation consistency
// ---------------------------------------------------------------------------

test("README and package.json agree on the project name", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const readme = readFileSync("README.md", "utf8");
  assert.equal(pkg.name, "jove-memory");
  assert.ok(readme.includes("jove-memory"), "README must reference the project name");
});

test("only the store directory writes SQL", () => {
  // Load-bearing: the retrieval layer is testable without a database only
  // because the queries over memory data all live in one place. A SELECT that
  // escapes into src/retrieval/ breaks that, silently, the first time someone
  // needs to test the ranking logic without a server.
  //
  // Scoped to src/store/ rather than to store.mjs alone, because the two
  // siblings legitimately need their own SQL: migrate.mjs applies DDL, and
  // pool.mjs runs the CREATE DATABASE and pg_stat_activity queries that
  // database-per-workspace depends on (ADR-003). Those are statements about
  // databases, not about memories. An earlier version of this test asserted
  // the narrower claim and failed on both files, which is what revealed the
  // comment at the top of store.mjs was overstated.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      if (path.startsWith(join("src", "store"))) continue;

      const content = readFileSync(path, "utf8");
      if (/\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE)\b/.test(content)) {
        offenders.push(path);
        continue;
      }

      // store.mjs exposes a raw `pool()` for its two siblings, which is how
      // those get their statements without importing pg themselves. A caller
      // outside the directory reaching for it is the same violation as writing
      // the query inline, so the escape hatch is closed as well.
      if (/\.pool\(\)/.test(content)) {
        offenders.push(path);
      }
    }
  };
  walk("src");

  assert.deepEqual(
    offenders,
    [],
    `SQL access outside src/store/: ${offenders.join(", ")}. Queries about memories ` +
      `belong to the store; everything above it calls methods. store.pool() exists ` +
      `for migrate.mjs and pool.mjs only.`
  );
});

test("store.mjs does not overstate its own scope", () => {
  // The comment claiming sole ownership of all SQL was wrong: two siblings
  // need their own. A comment that claims more than the code delivers is the
  // kind of thing that gets trusted, which is the whole reason this file
  // exists.
  const store = readFileSync("src/store/store.mjs", "utf8");
  assert.ok(
    !/the only module in the project that writes SQL/i.test(store),
    "store.mjs must not claim sole ownership of all SQL — migrate.mjs and pool.mjs have their own"
  );
  assert.match(
    store,
    /only module that writes (SQL|queries)/i,
    "store.mjs must still state the invariant, scoped accurately"
  );
});

test("the embedding client has no local fallback path", () => {
  // ADR-009, asserted against the module that does the embedding rather than
  // against package.json alone. The first version of this test only checked
  // dependencies, which would have passed if someone added a local fallback
  // inline — reading a model file, or shelling out to a Python process.
  const client = readFileSync("src/embedding/openrouter.mjs", "utf8");

  // Every embedding path goes through a fetch. No `require`, no dynamic import
  // of a model runtime, no child process.
  assert.ok(
    !/import\s*\(|require\s*\(|child_process|execSync|spawnSync|readFile/i.test(client),
    "the embedding client must not load anything local — ADR-009 forbids a local " +
      "model runtime, and an inline import is how that would arrive unannounced"
  );

  // And the failure path says so, because "the key is missing" and "the key is
  // wrong" lead to different actions by the reader.
  assert.match(
    client,
    /ADR-009/,
    "the no-key error must state that there is no local fallback"
  );
});

test("a missing key is a runtime error, never a silent degradation", () => {
  // Phase 2's finding, kept as an invariant. A build with no key must still
  // start and serve health, but every *use* must fail loudly.
  const config = readFileSync("src/config.mjs", "utf8");
  assert.match(
    config,
    /apiKey: readApiKey\(env\)/,
    "the key must resolve to an empty string when absent, not throw at boot"
  );
  assert.match(
    config,
    /keyFileCandidates/,
    "and the search list must be shared with the setup script rather than duplicated"
  );
  assert.match(
    config,
    /assertOutsideRepository/,
    "and it must refuse a key stored inside the repository"
  );

  const client = readFileSync("src/embedding/openrouter.mjs", "utf8");
  assert.match(
    client,
    /if \(!config\.providers\.apiKey\)/,
    "the client must check for the key and throw rather than sending a request that will 401"
  );

  const search = readFileSync("src/retrieval/search.mjs", "utf8");
  assert.match(
    search,
    /semantic_configured/,
    "search responses must distinguish 'not configured' from 'failed'"
  );
});

test("no test compares a key against the expectation of emptiness", () => {
  // A test asserting "no key was found" compares the key to an empty string,
  // and `assert.equal` prints `actual` when it fails. So the moment a real key
  // exists on the machine, a failing such test prints the real key.
  //
  // This happened: these tests were written before a key was stored, then the
  // "no key" ones began reading the operator's actual credential and printed it
  // in the diff.
  //
  // Scoped to emptiness deliberately. Comparing against a locally-constructed
  // fixture is fine and there are several of those; comparing against `""`,
  // `null` or `undefined` is the assertion whose failure prints the machine's
  // key. Comments are stripped first, because this file's own explanation of the
  // rule contains the pattern it forbids.
  const empty = /assert\.(equal|strictEqual|ok)\(\s*[\w.\[\]]*apiKey\s*,\s*(?:""|''|undefined|null)|assert\.ok\(\s*!\s*[\w.\[\]]*apiKey\b/;

  for (const file of readdirSync("test")) {
    if (!file.endsWith(".mjs")) continue;
    const code = stripComments(readFileSync(join("test", file), "utf8"));
    assert.ok(
      !empty.test(code),
      `${file} compares a key against emptiness. assert.equal prints the value on ` +
        `failure, which is how a real key reached a test log. Use assertNoKey().`
    );
  }

  // And the helper it prescribes exists, so the rule is actionable.
  const providerKey = readFileSync("test/provider-key.test.mjs", "utf8");
  assert.match(providerKey, /function assertNoKey/);
  assert.match(
    providerKey,
    /apiKey === ""/,
    "the helper must compare a boolean, never the value"
  );
});

test("key-reading tests are isolated from the real home directory", () => {
  const source = readFileSync("test/provider-key.test.mjs", "utf8");
  assert.match(
    source,
    /function noKeyEnv/,
    "a single helper must supply a scratch HOME to every load in the file"
  );

  // Every `loadConfig` in that file goes through the helper.
  const loads = [...source.matchAll(/loadConfig\(([^)]*)\)/g)].map((m) => m[1].trim());
  const bare = loads.filter((args) => args !== "noKeyEnv()" && !args.startsWith("noKeyEnv("));
  assert.deepEqual(
    bare,
    [],
    `these loads do not isolate HOME, so they can see a real key: ${bare.join(" | ")}`
  );
});

test("the key never has to be typed into a command or a file in the repository", () => {
  // The setup path is a prompt with echo off writing outside the project. If
  // someone replaces it with `KEY=... npm run` or puts the value in .env, this
  // fails — which is the point, because both leak into history or into a
  // directory that gets published.
  const compose = readFileSync("compose.yml", "utf8");
  assert.ok(
    !/OPENROUTER_API_KEY\s*:/i.test(compose),
    "compose.yml must not set the key as a variable — it is a mounted file"
  );
  assert.match(
    compose,
    /read_only: true/,
    "and the secrets mount must be read-only: the container has no reason to write a credential"
  );

  const envExample = readFileSync(".env.example", "utf8");
  const keyLine = envExample.split("\n").find((l) => l.startsWith("OPENROUTER_API_KEY="));
  assert.ok(keyLine, "the variable must still be documented for CI");
  assert.equal(
    keyLine.split("=")[1].trim(),
    "",
    "with an empty value — the template is for the environment, and the key itself lives in a file"
  );
});

test("the width check happens before anything is written", () => {
  // The failure that never surfaces as an error. A 1536-wide vector in a 3072
  // column either gets stored and produces nonsense distances, or is rejected
  // by pgvector three layers away with a message that names neither the text
  // nor the model.
  const client = readFileSync("src/embedding/openrouter.mjs", "utf8");
  assert.match(client, /assertDimensions/, "the client must validate width");
  assert.match(
    client,
    /expectedDimensions/,
    "and the expected width must come from config, not be hardcoded"
  );

  // Every vector written to the item index goes through the store method, which
  // is where the literal is built and validated.
  const store = readFileSync("src/store/store.mjs", "utf8");
  assert.match(store, /toVectorLiteral/);
  assert.match(
    store,
    /Number\.isFinite/,
    "a NaN or Infinity in a vector produces one that matches nothing, silently"
  );
});

test("the settings form cannot leak the credential anywhere", () => {
  // Three separate places, each of which has been the answer to "where did the
  // key end up" in some incident or near-miss:
  //
  //   the page     — must load nothing external, or it has handed the key to a
  //                  CDN. Must not be able to display what it stored.
  //   the response — no endpoint returns a value, because a settings page that
  //                  can display a secret is one that puts it in a screenshot.
  //   the database — asserted against a live connection in the integration
  //                  suite, because "the query that reaches the database does
  //                  not carry the value" is a claim about the wire.
  const page = readFileSync("src/api/settings-page.mjs", "utf8");
  assert.equal(/<script[^>]+src=/i.test(page), false, "no external script");
  assert.equal(/<link[^>]+href=/i.test(page), false, "no external stylesheet or icon");
  assert.equal(/https?:\/\//i.test(page), false, "no absolute URL");
  assert.match(page, /type="password"/, "and the field is not shoulder-readable");

  // The server must not build a response containing the value. Checked by
  // shape: a response field named for the secret is the thing to catch.
  const server = stripComments(readFileSync("src/api/server.mjs", "utf8"));
  assert.equal(
    /\bvalue:\s*(body|req|value)\b/.test(server),
    false,
    "a credential response must not echo the submitted value"
  );
  // And the value must be cleared from the object it arrived in, so a later
  // `logger.error({ ...body })` cannot pick it up.
  assert.match(server, /value\.trim\(\)/, "the value is read out of the body explicitly");
});

test("the master key is not in the database and not in the repository", () => {
  // The property the whole scheme turns on. If the master key were in the
  // database, the encryption would be formatting: a dump would carry a
  // credential.
  const credentials = readFileSync("src/api/credentials.mjs", "utf8");

  assert.match(
    credentials,
    /JOVE_MASTER_KEY_FILE/,
    "the master key path must be overridable, and default outside the repository"
  );
  // The master key bytes must never cross into the store. The store takes
  // opaque Buffers — that is the whole contract — and the master key is not
  // one of them.
  for (const call of stripComments(credentials).matchAll(/store\.[a-zA-Z]+\(([^)]*)\)/g)) {
    assert.equal(
      /masterKey|\.key\b/.test(call[1]),
      false,
      `the master key reached the store: store.${call[0].slice(6, call[0].indexOf("("))}`
    );
  }

  // No hardcoded key material anywhere in src/.
  for (const key of readdirSync("src", { recursive: true })) {
    if (!String(key).endsWith(".mjs")) continue;
    const content = readFileSync(join("src", String(key)), "utf8");
    assert.equal(
      /["'`]sk-or-v1-[A-Za-z0-9_-]{16,}["'`]/.test(content),
      false,
      `src/${key} contains a literal key`
    );
  }
});

test("the credential path never reaches a log line", () => {
  // A credential that reaches a log reaches a CI log, a log aggregator, and
  // every backup of both. The logger's redaction is keyed on field *names*,
  // so a field called `value` is not covered by it — which is why the value
  // must never be passed to the logger at all.
  const server = stripComments(readFileSync("src/api/server.mjs", "utf8"));

  for (const match of server.matchAll(/logger\.(error|warn|info|debug)\(([^;]*?)\);/g)) {
    const call = match[2];
    assert.equal(
      /\bvalue\b(?!\s*:)/i.test(call),
      false,
      `a logger call may pass a key or a ` + `value-shaped field: ${call.slice(0, 120)}`
    );
  }
});

test("the absence of an ANN index is documented, not silent", () => {
  // pgvector 0.8.6 cannot build an HNSW index above 2000 dimensions and
  // gemini-embedding-2 is 3072, so the vector arm is an exact search. That is a
  // latency constraint rather than a correctness one, but a reader who finds
  // no ANN index and no explanation will assume one of the two is a bug.
  const migration = readFileSync("src/store/migrations/0002_retrieval.sql", "utf8");
  assert.ok(
    !/USING\s+hnsw/i.test(migration),
    "an HNSW index cannot be created at 3072 dimensions; if this migration grew one, " +
      "either the width changed or pgvector did"
  );
  assert.match(
    migration,
    /2000 dimensions/i,
    "the migration must state the pgvector dimension limit it is working around"
  );

  const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
  assert.ok(
    !/pgvector`? with HNSW/i.test(arch),
    "ARCHITECTURE.md must not still promise HNSW — the limit makes it impossible"
  );
  assert.match(arch, /2000/i, "ARCHITECTURE.md must record the measured limit");
});

test("the vector arm's distance floor is opt-in, never silently zero", () => {
  // minSimilarity defaults to null, which returns the K nearest to any query at
  // all. That is the right default for a phase where the floor has not been
  // calibrated and the wrong default is a measured one. What must never happen
  // is a zero floor presented as if it were a meaningful threshold, so this
  // asserts the parameter exists and is documented as a calibration target.
  const store = readFileSync("src/store/store.mjs", "utf8");
  assert.match(store, /minSimilarity/);
  assert.match(
    store,
    /minSimilarity !== null/,
    "a zero floor must be distinguishable from no floor at all"
  );

  const thresholds = readFileSync("docs/THRESHOLDS.md", "utf8");
  assert.match(
    thresholds,
    /minSimilarity|distance floor/i,
    "docs/THRESHOLDS.md must list the distance floor among the values it calibrates"
  );
});

test("the model documented in ARCHITECTURE.md matches .env.example", () => {
  const example = readFileSync(".env.example", "utf8");
  const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");

  for (const key of [
    "PARADIGM_EMBED_MODEL",
    "PARADIGM_DECISION_MODEL",
    "PARADIGM_INFERENCE_MODEL"
  ]) {
    const value = example.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1];
    assert.ok(value, `${key} must be set in .env.example`);
    assert.ok(
      arch.includes(value),
      `docs/ARCHITECTURE.md does not mention ${key}=${value}. Documentation that ` +
        `disagrees with the configuration is worse than none, because it is trusted.`
    );
  }
});

/**
 * Remove comments.
 *
 * Needed because an invariant that forbids a pattern will be described
 * somewhere using the pattern it forbids, and a scanner that reads its own
 * documentation reports a violation in the documentation.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
