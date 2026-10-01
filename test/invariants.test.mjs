import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

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
