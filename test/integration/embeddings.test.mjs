import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../../src/logger.mjs";
import { createPoolManager } from "../../src/store/pool.mjs";
import { createStore } from "../../src/store/store.mjs";
import { migrate } from "../../src/store/migrate.mjs";
import { createSearcher } from "../../src/retrieval/search.mjs";
import { createEmbedder } from "../../src/embedding/openrouter.mjs";
import { createIngestor } from "../../src/ingest/embed.mjs";
import { loadConfig } from "../../src/config.mjs";

/**
 * Phase 4 against a real PostgreSQL and a fake provider.
 *
 * The gate has three parts, and only one of them can be verified without an
 * API key:
 *
 *   1. A text query returns results ranked by vector similarity — verifiable.
 *   2. No `semantic_error` anywhere in the response — verifiable.
 *   3. Image query retrieves text items and text query retrieves image items,
 *      in the same index — **not** verifiable here, because cross-modal
 *      retrieval is a property of the model's embedding space, and a fake
 *      embedder has no such property.
 *
 * Part 3 is asserted structurally instead: the code path is the same vector
 * arm in the same table, and a test proves the mechanism. Whether Gemini
 * Embedding 2 actually places an image near the text describing it is a fact
 * about Google, and the only honest way to establish it is a real request.
 * That is the one gate item this phase cannot close, and it is recorded as
 * such rather than assumed.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run with:\n" +
      "  TEST_DATABASE_URL=postgres://... npm run test:integration"
  );
}

const DIMS = 3072;
const noSleep = async () => {};

const url = new URL(DATABASE_URL);
const config = loadConfig({
  ...process.env,
  POSTGRES_HOST: url.hostname,
  POSTGRES_PORT: url.port,
  POSTGRES_SUPERUSER: decodeURIComponent(url.username),
  POSTGRES_PASSWORD: decodeURIComponent(url.password),
  POSTGRES_DB: url.pathname.replace(/^\//, ""),
  OPENROUTER_API_KEY: "test-key-never-leaves-this-machine",
  PARADIGM_EMBED_DIMENSIONS: String(DIMS)
});

const pools = createPoolManager(config, {});
const logger = createLogger({ level: "error", stream: { write() {} } });

let templateChecked = false;

before(async () => {
  const client = await pools.admin();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = 'paradigm_template'"
    );
    if (rows.length === 0) {
      throw new Error(
        "Database 'paradigm_template' does not exist. Create it with:\n" +
          "  CREATE DATABASE paradigm_template TEMPLATE template0;\n" +
          "  \\c paradigm_template\n" +
          "  CREATE EXTENSION IF NOT EXISTS vector;\n" +
          "  CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      );
    }
  } finally {
    client.release();
  }
  templateChecked = true;
});

after(async () => {
  await pools.close();
});

/**
 * A provider that embeds by keyword, so a query finds the item it should.
 *
 * This is not a local model and violates nothing: it is a hash function in a
 * test file, and it exists so the *plumbing* can be verified. What it cannot
 * verify is semantic quality, which is the point of the note at the top of
 * this file.
 *
 * Deterministic by construction — the same text always embeds to the same
 * vector — which is also true of the real model, so the determinism gate
 * holds in both.
 */
function keywordEmbedder({ dims = DIMS, calls = [] } = {}) {
  const VOCAB = [
    "semiconductor", "tunnelling", "quantum", "ledger", "escrow", "quarterly",
    "coffee", "grinder", "burrs", "boardwalk", "meadow", "trail", "forest",
    "mountain", "photograph", "diagram", "sketch", "map", "receipt", "invoice"
  ];

  function vectorFor(text) {
    const words = String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const v = new Array(dims).fill(0);

    for (const word of words) {
      const term = VOCAB.indexOf(word);
      if (term < 0) continue;
      // Keyword i lands in a band of dimensions, so two texts sharing a word
      // are genuinely closer than two that do not.
      const offset = term * 7;
      for (let i = 0; i < 7; i += 1) v[(offset + i) % dims] += 1;
    }

    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? v.map((_, i) => Math.sin(i) * 0.001) : v.map((x) => x / norm);
  }

  return {
    model: "google/gemini-embedding-2",
    dimensions: dims,
    calls,
    async embed(texts, opts = {}) {
      calls.push({ kind: "text", inputs: texts, opts });
      return texts.map(vectorFor);
    },
    async embedContent(content, opts = {}) {
      calls.push({ kind: "content", content, opts });
      // An "image" contributes to the same vector as the caption beside it.
      // Real cross-modal behaviour is Google's property, not this function's;
      // what is under test is that both land in one index.
      const parts = content.content ?? [];
      const words = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ");
      return vectorFor(words);
    },
    textInput: (text) => text,
    contentInput: (parts) => ({ content: parts })
  };
}

async function withWorkspace(t, { embedder = null, withStore = true } = {}) {
  assert.ok(templateChecked, "the before hook must have checked the template");

  const workspace = `t4_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await pools.provisionWorkspace(workspace, { migrate });
  t.after(() => pools.dropWorkspace(workspace).catch(() => {}));

  const store = createStore({ workspace, pools, logger });
  const emb = embedder ?? keywordEmbedder();
  return { workspace, store, embedder: emb, searcher: createSearcher({ store, logger, embed: emb }), ...(withStore ? {} : {}) };
}

// ---------------------------------------------------------------------------
// The real client, against a fake transport
// ---------------------------------------------------------------------------

/** A fake `fetch` that speaks the OpenRouter embeddings response shape. */
function fakeTransport({ record = [], status = 200, dims = DIMS, failTimes = 0 } = {}) {
  let remainingFailures = failTimes;

  return async (url, init) => {
    const parsed = JSON.parse(init.body);
    record.push({ url, body: parsed, headers: init.headers });

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    }
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    }

    const inputs = parsed.input;
    return new Response(
      JSON.stringify({
        object: "list",
        model: parsed.model,
        data: inputs.map((_, i) => ({
          object: "embedding",
          index: i,
          embedding: Array.from({ length: dims }, (_, d) => Math.cos(i + d) * 0.01)
        })),
        usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.0000024 }
      }),
      { status: 200 }
    );
  };
}

test("the real client stores a real 3072-wide vector that the store accepts", async (t) => {
  const { store, workspace } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({
    config,
    store,
    fetch: fakeTransport({ record }),
    sleep: noSleep
  });

  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i1", node_id: "n", content: "semiconductor fabs and quantum tunnelling" });

  const ingestor = createIngestor({ store, embedder, logger });
  const outcome = await ingestor.embedItem("i1");

  assert.equal(outcome.embedded, true, outcome.reason ?? "");
  assert.equal(outcome.dimensions, DIMS);
  assert.equal(record.length, 1, "one request");

  // And the stored vector is queryable by distance, which is the thing the
  // whole layer exists for.
  const found = await store.searchVector(Array.from({ length: DIMS }, (_, i) => Math.cos(i) * 0.01), {
    model: embedder.model
  });
  assert.ok(found.length > 0);
  assert.equal(found[0].id, "i1");
  assert.ok(found[0].similarity > 0.99, `expected a near-identical vector, got ${found[0].similarity}`);
  assert.equal(workspace.startsWith("t4_"), true);
});

test("the client and the store agree on width before anything is written", async (t) => {
  const { store } = await withWorkspace(t);
  const embedder = createEmbedder({
    config,
    store,
    // A provider that quietly changed its output width. The client's check
    // must catch it before pgvector does, three layers away.
    fetch: fakeTransport({ dims: 1536 }),
    sleep: noSleep
  });

  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i1", node_id: "n", content: "some text" });

  const ingestor = createIngestor({ store, embedder, logger });
  const outcome = await ingestor.embedItem("i1");

  assert.equal(outcome.embedded, false);
  assert.match(outcome.reason, /1536 dimensions/);

  // And nothing was written, rather than a bad vector sitting in the index.
  const coverage = await store.vectorCoverageSummary({ model: embedder.model });
  assert.equal(coverage.embedded, 0);
});

test("a repeated item is embedded once across runs", async (t) => {
  const { store, workspace } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({ config, store, fetch: fakeTransport({ record }), sleep: noSleep });

  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i1", node_id: "n", content: "coffee grinder burrs need replacing" });

  const ingestor = createIngestor({ store, embedder, logger });
  await ingestor.embedItem("i1");
  await ingestor.embedItem("i1");

  assert.equal(record.length, 1, `expected the second embed to be a cache hit, got ${record.length} requests`);
  assert.equal(workspace.startsWith("t4_"), true);
});

test("a provider outage leaves the item stored and unembedded, not unwritten", async (t) => {
  const { store } = await withWorkspace(t);
  const embedder = createEmbedder({
    config,
    store,
    fetch: fakeTransport({ failTimes: 99 }),
    sleep: noSleep
  });

  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i1", node_id: "n", content: "the quarterly ledger" });

  const ingestor = createIngestor({ store, embedder, logger });
  const outcome = await ingestor.embedItem("i1");

  // The memory exists. Losing it because an embedding failed would be the
  // worse failure by a wide margin.
  assert.equal(outcome.embedded, false);
  assert.ok(outcome.reason.includes("503"));

  const item = await store.readItem("i1");
  assert.ok(item, "the item must still be there");
  assert.equal(item.content, "the quarterly ledger");
});

test("coverage reports a null ratio for an empty corpus, not a perfect one", async (t) => {
  const { store } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({ config, store, fetch: fakeTransport({ record }), sleep: noSleep });
  const ingestor = createIngestor({ store, embedder, logger });

  const empty = await ingestor.coverage();
  assert.equal(empty.ratio, null, "nothing missing because there is nothing is not a perfect score");
  assert.equal(empty.eligible, 0);

  await store.createNode({ id: "n", label: "N" });
  for (const id of ["a", "b", "c", "d"]) {
    await store.upsertItem({ id, node_id: "n", content: `text ${id}` });
  }
  for (const id of ["a", "b"]) await ingestor.embedItem(id);

  const partial = await ingestor.coverage();
  assert.equal(partial.eligible, 4);
  assert.equal(partial.embedded, 2);
  assert.equal(partial.missing, 2);
  assert.equal(partial.ratio, 0.5);

  // And the work list is exactly what is missing.
  const todo = await ingestor.unembedded();
  assert.deepEqual(todo.map((t) => t.id).sort(), ["c", "d"]);
});

test("a re-embed run finds only what is missing, and bounds its own concurrency", async (t) => {
  const { store } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({
    config: { ...config, embedding: { ...config.embedding, batchSize: 2 } },
    store,
    fetch: fakeTransport({ record }),
    sleep: noSleep
  });

  await store.createNode({ id: "n", label: "N" });
  for (let i = 0; i < 7; i += 1) {
    await store.upsertItem({ id: `i${i}`, node_id: "n", content: `semiconductor item ${i}` });
  }

  const ingestor = createIngestor({ store, embedder, logger, batchSize: 2, concurrency: 2 });
  const report = await ingestor.embedItems(await ingestor.unembedded());

  assert.equal(report.total, 7);
  assert.equal(report.embedded, 7);
  assert.equal(report.failed, 0);
  assert.equal(record.length, 4, "7 items at 2 per request");

  // A second run has nothing to do. This is the property that makes a
  // re-embedding run idempotent rather than an ongoing cost.
  const second = await ingestor.embedItems(await ingestor.unembedded());
  assert.equal(second.total, 0);
  assert.equal(second.embedded, 0);
});

test("an item with no text is reported, not embedded into nothing", async (t) => {
  const { store } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({ config, store, fetch: fakeTransport({ record }), sleep: noSleep });

  await store.createNode({ id: "n", label: "N" });
  await store.upsertItem({ id: "i1", node_id: "n", content: "   " });

  const ingestor = createIngestor({ store, embedder, logger });
  const outcome = await ingestor.embedItem("i1");

  assert.equal(outcome.embedded, false);
  assert.match(outcome.reason, /no text to embed/);
  assert.equal(record.length, 0);
});

test("over-long text is truncated and the truncation is reported", async (t) => {
  const { store } = await withWorkspace(t);
  const record = [];
  const embedder = createEmbedder({ config, store, fetch: fakeTransport({ record }), sleep: noSleep });

  await store.createNode({ id: "n", label: "N" });
  const long = "semiconductor ".repeat(5000);
  await store.upsertItem({ id: "i1", node_id: "n", content: long });

  const ingestor = createIngestor({ store, embedder, logger });
  const outcome = await ingestor.embedItem("i1");

  assert.equal(outcome.embedded, true);
  assert.equal(outcome.truncated, true, "truncation must be visible, not silent");

  const sent = record[0].body.input[0];
  assert.ok(sent.length < long.length);
  assert.equal(sent.length, ingestor.maxChars);
});

// ---------------------------------------------------------------------------
// The gate, part 1: ranked by vector similarity, no semantic_error
// ---------------------------------------------------------------------------

async function seedSemanticCorpus(store, ingestor) {
  await store.createNode({ id: "root", label: "Root" });
  const items = [
    { id: "v1", content: "quantum tunnelling in semiconductors" },
    { id: "v2", content: "quarterly ledger and escrow reconciliation" },
    { id: "v3", content: "coffee grinder burr replacement schedule" }
  ];
  for (const item of items) {
    await store.upsertItem({ id: item.id, node_id: "root", content: item.content });
    await ingestor.embedItem(item.id);
  }
  return items.map((i) => i.id);
}

test("a text query returns results ranked by vector similarity", async (t) => {
  const calls = [];
  const { store, searcher, embedder } = await withWorkspace(t, { embedder: keywordEmbedder({ calls }) });
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);

  const body = await searcher.search("semiconductor quantum", { minSimilarity: 0.05 });

  assert.ok(body.results.length > 0, "the vector arm must find something");
  const first = body.results[0];
  assert.equal(first.item.id, "v1");
  assert.ok(first.detail.similarity > 0, "the top hit must carry a real similarity");
  assert.ok(first.arms.vector, "and be attributed to the vector arm");

  // The one that must not win. No shared vocabulary, no shared embedding
  // direction.
  assert.notEqual(first.item.id, "v3");
});

test("no semantic_error appears in a response whose vector arm ran", async (t) => {
  // The gate, stated as an assertion on a named field rather than on the
  // absence of a symptom.
  const { store, searcher, embedder } = await withWorkspace(t);
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);

  const body = await searcher.search("semiconductor quantum", { minSimilarity: 0.05 });

  assert.equal(body.debug.semantic_error, null, "the semantic layer ran");
  assert.equal(body.debug.arms.vector.ran, true);
  assert.equal(body.debug.allLayersRan, true);
  assert.equal(JSON.stringify(body).includes("semantic_error\":\""), false);
});

test("a semantic_error names the cause when the vector arm did not run", async (t) => {
  const { store } = await withWorkspace(t);
  await store.createNode({ id: "root", label: "Root" });
  // The content shares vocabulary with the query, so the lexical arm finds it
  // and a vector-arm failure still leaves an answer behind. That is the
  // property being tested: degradation, not total failure.
  await store.upsertItem({ id: "v1", node_id: "root", content: "semiconductor quantum tunnelling" });

  // A searcher with no embedder at all: CI's configuration, and the state a
  // deployment is in before a key is issued.
  const noEmbed = createSearcher({ store, logger, embed: null });
  const unconfigured = await noEmbed.search("semiconductor", { persist: false });

  assert.equal(unconfigured.debug.semantic_error, null, "not configured is not a failure");
  assert.equal(unconfigured.debug.semantic_configured, false);
  assert.match(unconfigured.debug.arms.vector.reason, /no embedder/);

  // A real provider failure does set it, and does report itself as configured.
  const broken = createSearcher({
    store,
    logger,
    embed: {
      model: "google/gemini-embedding-2",
      async embed() {
        throw new Error("provider unavailable");
      }
    }
  });
  const failed = await broken.search("semiconductor", { persist: false });

  assert.match(failed.debug.semantic_error, /provider unavailable/);
  assert.equal(failed.debug.semantic_configured, true, "a provider exists and failed — a different case");
  assert.equal(failed.debug.arms.vector.ran, false);
  // Still returns results on the other three layers.
  assert.ok(failed.results.length > 0, "three layers still answer (ADR-008)");
});

test("the same query returns the same ordering ten times against real vectors", async (t) => {
  const { store, searcher, embedder } = await withWorkspace(t);
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);

  const runs = [];
  for (let i = 0; i < 10; i += 1) {
    const body = await searcher.search("semiconductor quantum", { persist: false, minSimilarity: 0.05 });
    runs.push(body.results.map((r) => `${r.item.id}:${r.score}`).join("|"));
  }

  assert.equal(new Set(runs).size, 1, `not deterministic:\n${[...new Set(runs)].join("\n")}`);
});

// ---------------------------------------------------------------------------
// The gate, part 3: one index, structurally
// ---------------------------------------------------------------------------

test("a text query and an image query reach the same table, the same column", async (t) => {
  // The cross-modal claim cannot be tested with a fake embedder — whether a
  // real model places an image near the text describing it is a fact about
  // Google. What CAN be tested is the mechanism: both produce a 3072-wide
  // vector, both are written to memory_item_vectors, and both are read back by
  // the same distance query.
  const calls = [];
  const { store, searcher, embedder, workspace } = await withWorkspace(t, {
    embedder: keywordEmbedder({ calls })
  });
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);

  const byText = await searcher.search("semiconductor quantum", { minSimilarity: 0.05 });
  assert.equal(byText.queryType, "text");

  const byImage = await searcher.search("", {
    imageUrl: "https://example.invalid/semiconductor-diagram.png",
    caption: "semiconductor quantum diagram",
    minSimilarity: 0.05,
    persist: false
  });

  assert.equal(byImage.queryType, "image", "a caller must be able to tell what kind of query this was");
  assert.ok(byImage.results.length > 0, "an image query must retrieve items");
  assert.equal(byImage.results[0].item.id, "v1", "the caption's vocabulary led it to the right item");
  assert.equal(byImage.debug.semantic_error, null);

  // The mechanism: one request, the multimodal content shape, one vector.
  const contentCall = calls.find((c) => c.kind === "content");
  assert.ok(contentCall, "the image went through the multimodal path");
  assert.deepEqual(
    contentCall.content.content.map((p) => p.type),
    ["text", "image_url"],
    "caption and image in the same request, not two requests averaged"
  );
  assert.equal(contentCall.opts.inputType, "query");

  // And both are in the same index. One table, one model, one distance — the
  // image never gets a column of its own, which is the entire reason there is
  // no second embedding space to keep in sync (ADR-005).
  const coverage = await store.vectorCoverageSummary({ model: embedder.model });
  assert.equal(coverage.embedded, 3);
  assert.equal(coverage.missing, 0);

  // No table other than `memory_item_vectors` holds a vector. An earlier
  // version of this query counted `tableoid::text`, which is the table's own
  // OID — one distinct value by construction, so the assertion passed for the
  // wrong reason and would have kept passing if a second index appeared.
  const { rows } = await pools.poolFor(workspace).query(
    `SELECT count(DISTINCT c.relname) AS vector_tables
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE a.attname = 'embedding'
       AND a.atttypid = 'vector'::regtype
       AND c.relkind = 'r'`
  );
  assert.equal(Number(rows[0].vector_tables), 1, "exactly one table holds a vector — no second index");

  const { rows: itemRows } = await pools.poolFor(workspace).query(
    "SELECT count(DISTINCT item_id) AS items FROM memory_item_vectors"
  );
  assert.equal(Number(itemRows[0].items), 3);
});

test("an image query with no caption still searches, and skips the text arms", async (t) => {
  const { store, searcher, embedder } = await withWorkspace(t);
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);

  const body = await searcher.search("", {
    imageUrl: "https://example.invalid/photo.png",
    persist: false
  });

  // No text means no lexical comparison. Reporting hits from no comparison
  // would be worse than reporting that the arm did not run.
  assert.equal(body.debug.arms.bm25.ran, false);
  assert.match(body.debug.arms.bm25.reason, /no text/);
  assert.equal(body.debug.semantic_error, null, "the vector arm still ran on the image");
  assert.equal(body.query, "");
});

test("an embedder without the multimodal path says so, and does not fall back", async (t) => {
  const { store } = await withWorkspace(t);

  const textOnly = createSearcher({
    store,
    logger,
    embed: {
      model: "text-only-model",
      async embed(texts) {
        return texts.map(() => new Array(DIMS).fill(0.01));
      }
    }
  });

  const body = await textOnly.search("", { imageUrl: "https://example.invalid/x.png", persist: false });

  assert.equal(body.debug.arms.vector.ran, false);
  assert.match(body.debug.semantic_error, /no embedContent/);
  // The message must mention there is no local fallback, because that is the
  // next question a reader will have.
  assert.match(body.debug.semantic_error, /ADR-009/);
});

test("an image query still fuses with the graph and temporal arms", async (t) => {
  const { store, searcher, embedder } = await withWorkspace(t);
  const ingestor = createIngestor({ store, embedder, logger });
  await seedSemanticCorpus(store, ingestor);
  await store.addEdge("v1", "v3", "mentions", { weight: 0.9 });

  const body = await searcher.search("", {
    imageUrl: "https://example.invalid/x.png",
    caption: "semiconductor quantum",
    minSimilarity: 0.05,
    persist: false
  });

  assert.equal(body.debug.arms.vector.ran, true);
  assert.equal(body.debug.arms.bm25.ran, true, "the caption gives the lexical arm something to work with");
  assert.equal(body.debug.arms.graph.ran, true);
  assert.equal(body.debug.arms.temporal.ran, true);
  assert.equal(body.debug.allLayersRan, true, "all four arms run for a captioned image query");
});
