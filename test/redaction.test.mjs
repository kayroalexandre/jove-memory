import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * These tests guard the public-repository safety property.
 *
 * They run in CI. They are not a formality: the secret scanner is the only
 * thing standing between this project's memory content and a public GitHub
 * repository, and removing a rule from it must fail the build rather than
 * quietly widen what can be published.
 */

const SCANNER = "scripts/secret-scan.mjs";

function runScanner(cwd) {
  try {
    execFileSync("node", [join(cwd, SCANNER)], { cwd, stdio: "pipe" });
    return { blocked: false, output: "" };
  } catch (err) {
    return { blocked: true, output: String(err.stdout || "") + String(err.stderr || "") };
  }
}

/** Each case runs in an isolated copy of the scanner so no rule can bleed across. */
function withScannerFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "jove-scan-"));
  try {
    execFileSync("cp", ["-r", join(process.cwd(), "scripts"), dir]);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The scanner must block credentials
// ---------------------------------------------------------------------------

// Each credential is assembled at runtime from fragments.
//
// This is deliberate. These are not fake values — they match the real
// credential formats, and GitHub's push protection blocks a push containing a
// string it recognises as a live-shaped secret, correctly. Writing the literal
// here would mean the repository permanently carries a credential-shaped
// string that a reader could copy by accident, and it would mean every
// reviewer has to work out whether it is a real one.
//
// Assembling from parts keeps the test just as strict: the scanner still sees
// the exact bytes a real credential would produce.
const p = (...parts) => parts.join("");

const CREDENTIALS = [
  ["openrouter-style key", `OPENROUTER_API_KEY=${p("sk", "-or-v1-", "abcdefghij0123456789klmnopqrstuv")}`],
  ["openai-style key", `const key = '${p("sk", "-proj-", "abcdefghij0123456789KLmnopqrstuv")}'`],
  ["anthropic key", `ANTHROPIC_API_KEY=${p("sk", "-ant-api03-", "abcdefghij0123456789")}`],
  ["github token", `GITHUB_TOKEN=${p("gh", "p_", "abcdefghij0123456789klmnopqrstuvwxyz0123")}`],
  ["aws access key", `aws_key = '${p("AKIA", "IOSFODNN7EXAMPLE")}'`],
  ["google api key", `GOOGLE_KEY=${p("AIza", "SyD-abcdefghij0123456789klmnopqrstuvw")}`],
  ["slack token", `SLACK=${p("xox", "b-123456789012-", "abcdefghijklmnop")}`],
  ["npm token", `NPM_TOKEN=${p("npm", "_abcdefghij0123456789klmnopqrstuvwxyz0123")}`],
  ["private key header", `${p("-----BEGIN RSA ", "PRIVATE KEY-----")}\nMIIEow==`],
  ["postgres url with password", `DATABASE_URL=${p("postgres://user:", "hunter2secret", "@db:5432/jove")}`],
  [
    "jwt",
    `token = '${p("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")}'`
  ]
];

for (const [name, content] of CREDENTIALS) {
  test(`secret-scan blocks ${name}`, () => {
    withScannerFixture((dir) => {
      writeFileSync(join(dir, "leak.txt"), content);
      const { blocked, output } = runScanner(dir);
      assert.ok(blocked, `expected ${name} to be blocked, got clean scan`);
      assert.match(output, /BLOCK/);
    });
  });
}

// ---------------------------------------------------------------------------
// The scanner must block memory content and data files
// ---------------------------------------------------------------------------

test("secret-scan blocks a .sqlite file", () => {
  withScannerFixture((dir) => {
    writeFileSync(join(dir, "memory.sqlite"), "x");
    assert.ok(runScanner(dir).blocked);
  });
});

test("secret-scan blocks a .brain snapshot", () => {
  withScannerFixture((dir) => {
    writeFileSync(join(dir, "export.brain"), "{}");
    assert.ok(runScanner(dir).blocked);
  });
});

test("secret-scan blocks paths holding memory content", () => {
  withScannerFixture((dir) => {
    execFileSync("mkdir", ["-p", join(dir, "pgdata")]);
    writeFileSync(join(dir, "pgdata", "base.dat"), "x");
    assert.ok(runScanner(dir).blocked);
  });
});

test("secret-scan blocks an .env file", () => {
  withScannerFixture((dir) => {
    writeFileSync(join(dir, ".env"), "SOMETHING=1");
    assert.ok(runScanner(dir).blocked);
  });
});

test("secret-scan blocks credentials.json", () => {
  withScannerFixture((dir) => {
    writeFileSync(join(dir, "credentials.json"), "{}");
    assert.ok(runScanner(dir).blocked);
  });
});

// ---------------------------------------------------------------------------
// The scanner must NOT block legitimate content
// ---------------------------------------------------------------------------

test("secret-scan allows .env.example with empty placeholders", () => {
  const { blocked, output } = runScanner(process.cwd());
  assert.ok(!blocked, `.env.example must pass:\n${output}`);
});

test("secret-scan allows this repository's own documentation", () => {
  const { blocked, output } = runScanner(process.cwd());
  assert.ok(!blocked, `repo must scan clean:\n${output}`);
});

test("secret-scan allows placeholder values in env assignments", () => {
  withScannerFixture((dir) => {
    writeFileSync(
      join(dir, "config.txt"),
      [
        "OPENROUTER_API_KEY=",
        'MINIO_ROOT_PASSWORD="changeme"',
        "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}",
        "SOME_TOKEN=your-token-here"
      ].join("\n")
    );
    assert.ok(!runScanner(dir).blocked);
  });
});

// ---------------------------------------------------------------------------
// Rule inventory: removing a rule must fail this test
// ---------------------------------------------------------------------------

test("the scanner declares every credential rule it enforces", () => {
  const source = readFileSync(SCANNER, "utf8");

  const required = [
    "OpenAI-style key",
    "GitHub token",
    "AWS access key id",
    "Google API key",
    "Slack token",
    "Private key header",
    "JWT",
    "Postgres URL with password",
    "NPM token",
    "Anthropic key"
  ];

  for (const rule of required) {
    assert.ok(
      source.includes(`"${rule}"`),
      `secret-scan.mjs no longer declares the "${rule}" rule. ` +
        `If this was removed deliberately, understand that the matching credential ` +
        `can now be committed to a public repository.`
    );
  }

  for (const ext of [".sqlite", ".brain", ".env", ".pem", ".key"]) {
    assert.ok(
      source.includes(`"${ext}"`),
      `secret-scan.mjs no longer blocks "${ext}" files`
    );
  }
});

// ---------------------------------------------------------------------------
// Linter guards the same properties
// ---------------------------------------------------------------------------

test("lint rejects a local model runtime import", () => {
  const dir = mkdtempSync(join(tmpdir(), "jove-lint-"));
  try {
    execFileSync("mkdir", ["-p", join(dir, "src"), join(dir, "docs"), join(dir, "scripts")]);
    execFileSync("cp", ["-r", join(process.cwd(), "scripts"), join(dir, ".")]);
    execFileSync("cp", [
      join(process.cwd(), "README.md"),
      join(dir, "README.md")
    ]);
    execFileSync("cp", ["-r", join(process.cwd(), "docs"), join(dir, ".")]);
    writeFileSync(
      join(dir, "src", "embeddings.mjs"),
      'import "@huggingface/transformers";\n'
    );
    let failed = false;
    try {
      execFileSync("node", [join(dir, "scripts", "lint.mjs")], { cwd: dir, stdio: "pipe" });
    } catch {
      failed = true;
    }
    assert.ok(failed, "lint must reject a @huggingface/transformers import (ADR-009)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint rejects console.log in src/", () => {
  const dir = mkdtempSync(join(tmpdir(), "jove-lint-"));
  try {
    execFileSync("mkdir", ["-p", join(dir, "src"), join(dir, "docs")]);
    execFileSync("cp", ["-r", join(process.cwd(), "scripts"), join(dir, ".")]);
    execFileSync("cp", [join(process.cwd(), "README.md"), join(dir, "README.md")]);
    execFileSync("cp", ["-r", join(process.cwd(), "docs"), join(dir, ".")]);
    writeFileSync(join(dir, "src", "api.mjs"), 'console.log("payload", body);\n');
    let failed = false;
    try {
      execFileSync("node", [join(dir, "scripts", "lint.mjs")], { cwd: dir, stdio: "pipe" });
    } catch {
      failed = true;
    }
    assert.ok(failed, "lint must reject console.log in src/ — it can leak payloads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
