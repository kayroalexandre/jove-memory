#!/usr/bin/env node
/**
 * Linter. Deliberately dependency-free: a project this small should not carry
 * a linter's transitive dependency tree as attack surface.
 *
 * Checks that catch real defects rather than style preferences:
 *   - every .mjs parses
 *   - no leftover local-model imports (ADR-009)
 *   - no `console.log` in src/ (would leak payloads)
 *   - no hardcoded absolute paths
 *   - docs referenced in README exist
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { execSync } from "node:child_process";

const problems = [];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else out.push(full);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

const files = walk(".");
const jsFiles = files.filter((f) => [".mjs", ".js"].includes(extname(f)));

// 1. Every JS file must parse.
for (const file of jsFiles) {
  try {
    execSync(`node --check ${JSON.stringify(file)}`, { stdio: "pipe" });
  } catch (err) {
    problems.push(`${file}: does not parse — ${String(err.stderr || err).split("\n")[0]}`);
  }
}

// 2. No local model runtime anywhere (ADR-009).
const FORBIDDEN_IMPORTS = [
  "@huggingface/transformers",
  "onnxruntime",
  "@xenova/transformers",
  "Xenova/all-MiniLM",
  "onnx-community/"
];
for (const file of files) {
  if (![".mjs", ".js", ".json", ".yml", ".sh"].includes(extname(file))) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const bad of FORBIDDEN_IMPORTS) {
    if (content.includes(bad) && !content.includes("ADR-009") && !file.includes("secret-scan")) {
      problems.push(`${file}: references "${bad}" — local model runtime is forbidden (ADR-009)`);
    }
  }
}

// 3. No console.log in src/ — payload leakage risk (docs/SECURITY.md).
const srcFiles = jsFiles.filter((f) => f.startsWith("src" + "/"));
for (const file of srcFiles) {
  const content = readFileSync(file, "utf8");
  content.split("\n").forEach((line, i) => {
    if (/\bconsole\.(log|dir|debug)\s*\(/.test(line)) {
      problems.push(`${file}:${i + 1}: console.log in src/ — use the logger with redaction`);
    }
  });
}

// 4. No hardcoded absolute paths outside docs and scripts.
for (const file of srcFiles) {
  const content = readFileSync(file, "utf8");
  content.split("\n").forEach((line, i) => {
    if (/\/home\/[a-z]/.test(line)) {
      problems.push(`${file}:${i + 1}: hardcoded absolute home path`);
    }
  });
}

// 5. Docs linked from README must exist.
const readme = readFileSync("README.md", "utf8");
for (const match of readme.matchAll(/\]\((docs\/[^)]+)\)/g)) {
  if (!existsSync(match[1])) {
    problems.push(`README.md: links to ${match[1]} which does not exist`);
  }
}

// 6. Every doc must have a title (a bare file is usually a mistake).
for (const file of files.filter((f) => f.startsWith("docs/") && f.endsWith(".md"))) {
  const content = readFileSync(file, "utf8");
  if (!content.startsWith("# ")) {
    problems.push(`${file}: does not start with a level-1 title`);
  }
}

if (problems.length > 0) {
  console.error("lint: problems found\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("");
  process.exit(1);
}

console.error(`lint: ${files.length} files clean`);
process.exit(0);
