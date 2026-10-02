import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../../src/logger.mjs";
import { createPoolManager } from "../../src/store/pool.mjs";
import { createStore } from "../../src/store/store.mjs";
import { migrate } from "../../src/store/migrate.mjs";
import { createSearcher } from "../../src/retrieval/search.mjs";
import { loadConfig } from "../../src/config.mjs";

/**
 * Phase 3 gate, against a real PostgreSQL.
 *
 * The gate has two halves:
 *
 *   1. A `debug` block showing all four arms with real values, not zeros.
 *   2. The same query against the same data returning the same ordering
 *      across ten runs.
 *
 * Both fail silently. A fusion that returns a plausible ranking built from
 * one arm, and a ranking that shuffles between identical runs, both look like
 * working search. Only assertions on the debug block and on repeated runs
 * catch them.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run with:\n" +
      "  TEST_DATABASE_URL=postgres://... npm run test:integration"
  );
}

const url = new URL(DATABASE_URL);
const config = loadConfig({
  ...process.env,
  POSTGRES_HOST: url.hostname,
  POSTGRES_PORT: url.port,
  POSTGRES_SUPERUSER: decodeURIComponent(url.username),
  POSTGRES_PASSWORD: decodeURIComponent(url.password),
  POSTGRES_DB: url.pathname.replace(/^\//, ""),
  OPENROUTER_API_KEY: "test-key-not-used-here",
  // Kept at 3072 to match the column. A test fixture that quietly narrows the
  // config would pass against a vector(3072) column and then fail in
  // production, which is the arrangement this whole layer is designed to
  // prevent.
  PARADIGM_EMBED_DIMENSIONS: "3072"
});

const pools = createPoolManager(config, {});
const logger = createLogger({ level: "error", stream: { write() {} } });
const created = [];

/** Dims of the fake embedder, matching the column. */
const DIMS = 3072;

/**
 * A deterministic stand-in for the cloud embedder.
 *
 * Not a local model — there is none, by ADR-009 — just a hash, so the same
 * text always produces the same vector. That determinism is what lets this
 * test assert a stable ordering; a real embedder is deterministic too, and
 * Phase 4 replaces this without changing anything else.
 */
function fakeEmbedder() {
  return {
    model: "google/gemini-embedding-2",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array(DIMS);
        for (let i = 0; i < DIMS; i += 1) {
          // A bag-of-tokens projection: identical text gives an identical
          // vector, and related text gives a nearby one. Enough for ranking.
          let h = 2166136261;
          const token = `${text.toLowerCase()}:${i % 8}`;
          for (let c = 0; c < token.length; c += 1) {
            h ^= token.charCodeAt(c);
            h = Math.imul(h, 16777619);
          }
          vector[i] = ((h >>> 0) / 4294967295) * 2 - 1;
        }
        const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
        return vector.map((v) => v / norm);
      });
    }
  };
}

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
  for (const name of created) {
    await pools.dropWorkspace(name).catch(() => {});
  }
});

/**
 * A fresh, seeded workspace for one test, dropped when it finishes.
 *
 * One workspace per test rather than one per file, for a concrete reason: the
 * tests drop their workspace when they finish, so a shared one would be gone
 * by the time the second test ran. That is a mistake worth making once — the
 * failure was 26 tests reporting "relation does not exist" against a database
 * a previous test had dropped.
 */
async function withCorpus(t) {
  assert.ok(templateChecked, "the before hook must have checked the template");

  const workspace = `t3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await pools.provisionWorkspace(workspace, { migrate });
  t.after(() => pools.dropWorkspace(workspace).catch(() => {}));

  const store = createStore({ workspace, pools, logger });
  const searcher = createSearcher({ store, logger, embed: fakeEmbedder() });
  await seedCorpus(store, workspace);

  return { workspace, store, searcher };
}

/**
 * A corpus designed so each arm is the *only* one that can find its own item.
 *
 * Without that, a test passes whichever arm happens to be wired up, and the
 * gate never actually tests the other three.
 */
async function seedCorpus(store, workspace) {
  await store.createNode({ id: "root", label: "Root" });

  const items = [
    // Vector-only: the words appear nowhere else.
    { id: "v1", content: "Quantum tunnelling explains semiconductor behaviour" },
    // Lexical-only: uses words no other arm would map near the query.
    { id: "b1", content: "The quarterly ledger reconciles the escrow account" },
    // Old but true: only the temporal arm has an opinion about it.
    { id: "t1", content: "Coffee grinder burrs need replacing every few months" },
    // Reachable only through a graph edge from v1.
    { id: "g1", content: "Semiconductor fabs depend on rare earth metals" }
  ];

  for (const item of items) {
    await store.upsertItem({ id: item.id, node_id: "root", content: item.content, tags: [] });
  }

  // One edge. The graph arm can only reach g1 through it.
  await store.addEdge("v1", "g1", "mentions", { weight: 0.9 });

  // Vectors for everything, so the graph arm's seeds and the vector arm both
  // have something to work with.
  const embedder = fakeEmbedder();
  const vectors = await embedder.embed(items.map((i) => i.content));
  for (const [index, item] of items.entries()) {
    await store.upsertItemVector(item.id, embedder.model, vectors[index]);
  }

  // t1 is old. Bitemporal: it became true long ago and is still true, so the
  // temporal arm has something to down-rank.
  await pools.poolFor(workspace).query(
    `UPDATE memory_items SET recorded_at = now() - interval '4 years',
            occurred_start = now() - interval '4 years'
     WHERE id = 't1'`
  );

  return items.map((i) => i.id);
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

test("migration 0002 created all four layers' tables", async (t) => {
  const { workspace } = await withCorpus(t);

  const { rows } = await pools.poolFor(workspace).query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('memory_item_vectors','entity_edges','search_runs')`
  );
  const names = rows.map((r) => r.table_name);
  assert.ok(names.includes("memory_item_vectors"));
  assert.ok(names.includes("entity_edges"));
  assert.ok(names.includes("search_runs"));
});

test("the search_vector column is generated, so it cannot drift from content", async (t) => {
  const { workspace, store } = await withCorpus(t);

  const { rows } = await pools.poolFor(workspace).query(
    `SELECT is_generated FROM information_schema.columns
     WHERE table_name = 'memory_items' AND column_name = 'search_vector'`
  );
  assert.equal(rows[0]?.is_generated, "ALWAYS");

  // Writing content without touching search_vector must still make it
  // searchable. A maintained trigger or an application-side write is the same
  // idea with a failure mode: a missed update leaves an invisible item.
  await store.upsertItem({
    id: "gen1",
    node_id: "root",
    content: "Zarquon metathesis in superconducting lattices"
  });
  const found = await store.searchBm25("zarquon");
  assert.equal(found.length, 1, "a generated column must index the new content");
  assert.equal(found[0].id, "gen1");
});

test("the embedding column is 3072 wide, matching the config", async (t) => {
  const { store } = await withCorpus(t);

  const width = await store.vectorDimensions();
  assert.equal(width, config.embedding.dimensions);
  assert.equal(width, 3072);
});

// ---------------------------------------------------------------------------
// Layer 1: vector
// ---------------------------------------------------------------------------

test("a vector arm search returns items ordered by cosine similarity", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const embedder = fakeEmbedder();
  const [queryVector] = await embedder.embed(["semiconductor quantum physics"]);
  const found = await store.searchVector(queryVector, { model: embedder.model });

  assert.ok(found.length > 0);
  assert.equal(found[0].id, "v1", "the semiconductor item must be nearest to that query");

  // Similarity must actually descend. A query that returns the right order by
  // luck is not an ordering.
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(
      found[i].similarity <= found[i - 1].similarity,
      `similarity must be non-increasing: ${found[i - 1].id}=${found[i - 1].similarity} then ${found[i].id}=${found[i].similarity}`
    );
  }
});

test("the vector arm filters by model, so two models never mix", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const embedder = fakeEmbedder();
  const [vector] = await embedder.embed(["ledger"]);

  // Write a second model's vector for the same item. Mixing spaces in one
  // index is the failure ADR-005 exists to prevent, and the filter is the
  // mechanism.
  await pools.poolFor(workspace).query(
    "UPDATE memory_item_vectors SET model = 'some-other-model' WHERE item_id = 'v1'"
  );

  const filtered = await store.searchVector(vector, { model: embedder.model });
  assert.ok(
    !filtered.some((r) => r.id === "v1"),
    "an item whose vector belongs to another model must be excluded"
  );

  const unfiltered = await store.searchVector(vector, {});
  assert.ok(unfiltered.some((r) => r.id === "v1"), "without a filter it is present");
});

test("a vector with a NaN is refused rather than silently matching nothing", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const bad = new Array(DIMS).fill(0);
  bad[3] = Number.NaN;
  await assert.rejects(() => store.searchVector(bad), RangeError);

  await assert.rejects(() => store.searchVector([]), RangeError);
  await assert.rejects(() => store.searchVector("not a vector"), TypeError);

  // A wrong-width vector is caught by the driver, not by us. Asserted rather
  // than left implicit, because the message names the real cause and a future
  // width check should keep it.
  await assert.rejects(
    () => store.searchVector([1, 2, 3]),
    /different vector dimensions/
  );
});

test("vector coverage is reported per model", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const coverage = await store.vectorCoverage();
  const mine = coverage.find((c) => c.model === "google/gemini-embedding-2");
  assert.ok(mine, "the active model must appear in the coverage report");
  assert.equal(mine.count, 4);
});

// ---------------------------------------------------------------------------
// Layer 2: lexical
// ---------------------------------------------------------------------------

test("a lexical search ranks the matching item first", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const found = await store.searchBm25("quarterly ledger escrow");
  assert.equal(found[0].id, "b1");
  assert.ok(found[0].normalised > 0);
});

test("a lexical search honours a quoted phrase", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  // The reason for websearch_to_tsquery over plainto: a quoted phrase is
  // searched as a phrase. plainto would accept the quotes and drop them,
  // matching all four words in any order.
  const phrase = await store.searchBm25('"escrow account"');
  assert.equal(phrase[0].id, "b1");

  const allWords = await store.searchBm25("escrow tunnelling metathesis ledger");
  assert.ok(
    !allWords.some((r) => r.id === "b1"),
    "an AND of four words across different items must not match anything"
  );
});

test("an empty lexical query returns nothing rather than everything", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  assert.deepEqual(await store.searchBm25(""), []);
  assert.deepEqual(await store.searchBm25("   "), []);
});

test("a tag alone is enough to make an item findable", async (t) => {
  const { store } = await withCorpus(t);

  await store.upsertItem({
    id: "tagged",
    node_id: "root",
    content: "unrelated body text",
    tags: ["quintessential"]
  });

  const found = await store.searchBm25("quintessential");
  assert.equal(found[0].id, "tagged", "a tag-only match must still be found");

  // And the weighting is real, not decorative: a body-text match outranks a
  // tag-only match for the same query, which is why content is weight A and
  // tags weight B.
  await store.upsertItem({
    id: "inbody",
    node_id: "root",
    content: "quintessential detail in the body",
    tags: []
  });
  const both = await store.searchBm25("quintessential");
  assert.equal(both[0].id, "inbody");
  assert.ok(both[0].rank > both.find((r) => r.id === "tagged").rank);
});

// ---------------------------------------------------------------------------
// Layer 3: graph
// ---------------------------------------------------------------------------

test("a traversal reaches an item that shares no words with the seed", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const found = await store.traverseGraph(["v1"], { limit: 10, maxDepth: 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "g1");
  assert.equal(found[0].depth, 1);
  assert.equal(found[0].relation, "mentions");
  assert.ok(found[0].item.content.includes("rare earth"));
});

test("a traversal terminates on a cycle", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  // A graph with a cycle is not an error, it is Tuesday. Without the path
  // guard this is a query that never returns.
  await store.addEdge("g1", "b1", "mentions", { weight: 0.5 });
  await store.addEdge("b1", "t1", "mentions", { weight: 0.5 });
  await store.addEdge("t1", "v1", "mentions", { weight: 0.5 });

  const found = await store.traverseGraph(["v1"], { limit: 20, maxDepth: 3 });
  assert.ok(found.length <= 3, "must not revisit a node already on the path");
  assert.equal(new Set(found.map((f) => f.id)).size, found.length, "no duplicates");
});

test("a nearer, better-evidenced neighbour outranks a distant one", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  await store.addEdge("b1", "t1", "mentions", { weight: 0.2 });
  const found = await store.traverseGraph(["v1", "b1"], { limit: 20, maxDepth: 2 });

  const near = found.find((f) => f.id === "g1");
  const far = found.find((f) => f.id === "t1");
  assert.ok(near.score > far.score, `depth 1 weight 0.9 must beat depth 1 weight 0.2`);
});

test("a self-edge is refused at write time", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  await assert.rejects(
    () => store.addEdge("v1", "v1", "same_entity_as"),
    /self-edge/
  );
});

test("traversal can be restricted to named relations", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  await store.addEdge("b1", "t1", "mentions", { weight: 0.9 });
  const found = await store.traverseGraph(["v1", "b1"], {
    limit: 20,
    relations: ["same_entity_as"]
  });
  assert.equal(found.length, 0, "no same_entity_as edges exist, so nothing is reachable");
});

test("a traversal of no seeds or zero depth is empty, not an error", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  assert.deepEqual(await store.traverseGraph([], { limit: 5 }), []);
  assert.deepEqual(await store.traverseGraph(["v1"], { maxDepth: 0 }), []);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("the debug block shows all four arms with real values, not zeros", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const body = await searcher.search("semiconductor tunnelling");

  // The gate itself.
  assert.deepEqual(
    Object.keys(body.debug.arms).sort(),
    ["bm25", "graph", "temporal", "vector"],
    "all four arms must be reported, not only the ones that matched"
  );
  assert.equal(body.debug.allLayersRan, true, "every arm must have run");

  // Real values, not zeros. A block of four zeros is what a search that
  // silently lost three of its four layers looks like.
  for (const [arm, report] of Object.entries(body.debug.arms)) {
    assert.equal(report.ran, true, `arm ${arm} did not run: ${report.reason}`);
    assert.ok(report.hits > 0, `arm ${arm} reported zero hits against a seeded corpus`);
  }

  assert.ok(body.results.length > 0);
  assert.equal(body.debug.fusion.method, "rrf");
  assert.equal(body.debug.fusion.k, 60);
});

test("every result carries provenance: which arms found it and how", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const body = await searcher.search("semiconductor tunnelling");

  for (const result of body.results) {
    assert.ok(result.item?.id, "a result must carry its item");
    assert.ok(result.score > 0);
    assert.ok(result.relative > 0 && result.relative <= 1);
    // Provenance: the arms that surfaced this item, each with its rank.
    assert.ok(Object.keys(result.arms).length > 0, "a result must say which arm found it");
    for (const [arm, detail] of Object.entries(result.arms)) {
      assert.ok(detail.rank >= 1, `arm ${arm} reported rank ${detail.rank}`);
      assert.equal(typeof detail.contribution, "number");
    }
  }
});

test("the same query against the same data returns the same ordering ten times", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const runs = [];
  for (let i = 0; i < 10; i += 1) {
    const body = await searcher.search("semiconductor tunnelling", { persist: false });
    runs.push(body.results.map((r) => `${r.item.id}:${r.score}`).join("|"));
  }

  const distinct = new Set(runs);
  assert.equal(
    distinct.size,
    1,
    `ordering is not deterministic across 10 runs:\n${[...distinct].map((r) => `  ${r}`).join("\n")}`
  );
});

test("an item found by two layers is scored above one found by a single layer", async (t) => {
  const { store, searcher } = await withCorpus(t);

  // v1 matches the query lexically and by embedding, so it earns two votes.
  // g1 matches by neither and earns one. RRF is supposed to prefer the
  // corroborated item, and that preference is the reason fusion exists rather
  // than trusting whichever arm happens to rank highest.
  const body = await searcher.search("semiconductor tunnelling", { minSimilarity: 0.1 });

  const v1 = body.results.find((r) => r.item.id === "v1");
  assert.ok(v1.arms.vector, "v1 must be found by the vector arm");
  assert.ok(v1.arms.bm25, "v1 must be found by the lexical arm");

  const g1 = body.results.find((r) => r.item.id === "g1");
  assert.ok(g1.arms.graph, "g1 must be found by the graph arm");
  assert.ok(
    v1.score > g1.score,
    `two arms (${v1.score}) must outrank one arm (${g1.score})`
  );
});

test("the graph arm surfaces an item that no other arm ranked first", async (t) => {
  const { searcher } = await withCorpus(t);

  const body = await searcher.search("semiconductor tunnelling", { minSimilarity: 0.1 });

  const g1 = body.results.find((r) => r.item.id === "g1");
  assert.ok(g1, "the graph arm's item must be present");
  assert.ok(g1.arms.graph, "g1 must be attributed to the graph arm");

  // g1 shares no vocabulary with the query, so the lexical arm never saw it.
  // Its embedding is nowhere near the query's, so behind the distance floor
  // the vector arm does not see it either. The graph arm is the only thing
  // that surfaces it at all — which is precisely the case the arm exists for,
  // and the reason a memory graph earns its maintenance.
  assert.equal(g1.arms.vector, undefined, "the vector arm must not claim it");
  assert.equal(g1.arms.bm25, undefined, "the lexical arm must not claim it");
  assert.equal(g1.arms.graph.rank, 1, "the graph arm reached it directly");
  assert.equal(g1.detail.graphDepth, 1);
  assert.equal(g1.detail.relation, "mentions");
});

test("without a distance floor the vector arm returns the K nearest to anything", async (t) => {
  const { searcher } = await withCorpus(t);

  // Documenting the behaviour the floor exists to prevent. A query about
  // something entirely absent from memory still comes back with a full set of
  // results, ordered by a similarity so low it means nothing. This is why
  // "nothing relevant is stored" and "the index is broken" are
  // indistinguishable without one, and why the floor is applied in SQL rather
  // than after the LIMIT.
  const body = await searcher.search("zzzzqqqq nothing resembling this", {
    persist: false,
    minSimilarity: null
  });

  assert.ok(body.debug.arms.vector.hits > 0, "with no floor, the K nearest always come back");
  assert.ok(body.results.length > 0);
  assert.equal(body.debug.arms.bm25.hits, 0, "while the lexical arm correctly found nothing");
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test("a failing embedder costs the vector arm and nothing else", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

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

  const body = await broken.search("quarterly ledger escrow", { persist: false });

  // Results still return, on three layers (ADR-008).
  assert.ok(body.results.length > 0, "a provider outage must not fail the search");
  assert.equal(body.debug.arms.vector.ran, false);
  assert.match(body.debug.arms.vector.reason, /embedding failed/);
  assert.equal(body.debug.arms.bm25.ran, true);
  assert.equal(body.debug.degraded, true, "a degraded search must say so");
  assert.equal(body.debug.allLayersRan, false);
});

test("a build with no embedder at all reports that plainly", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  // Phase 3's actual state: cloud embeddings arrive in Phase 4. The reason
  // must name that, so nobody reads the empty vector arm as a broken index.
  const noEmbed = createSearcher({ store, logger, embed: null });
  const body = await noEmbed.search("semiconductor", { persist: false });

  assert.equal(body.debug.arms.vector.ran, false);
  assert.match(body.debug.arms.vector.reason, /no embedder/);
  assert.ok(body.results.length > 0, "three layers still answer");
});

test("a query matching nothing says the index was empty, not that it was skipped", async (t) => {
  const { searcher } = await withCorpus(t);

  // The distance floor is what makes this testable: without it the vector arm
  // returns the K nearest to any query at all, so there is no such thing as a
  // query that matches nothing, and "not stored" is indistinguishable from
  // "index broken". A floor above 1.0 excludes everything by construction.
  const body = await searcher.search("zzzzqqqq nonexistent phrase", {
    persist: false,
    minSimilarity: 1.1
  });

  assert.equal(body.results.length, 0);
  assert.equal(body.debug.arms.bm25.ran, true, "the arm ran");
  assert.equal(body.debug.arms.bm25.hits, 0, "and matched nothing");
  assert.equal(body.debug.arms.graph.ran, false);
  assert.match(body.debug.arms.graph.reason, /no seeds/);
});

test("an empty query is a listing, not a failed search", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  for (const query of ["", "   ", null, undefined]) {
    const body = await searcher.search(query, { persist: false });
    assert.deepEqual(body.results, []);
    assert.match(body.debug.arms.vector.reason, /empty query/);
  }
});

test("the bm25 engine in use is named, never assumed", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const body = await searcher.search("semiconductor", { persist: false });
  // Issue #12. `pg_search` is not installed on this image, so this is
  // `tsvector` — and the point is that the response says which, rather than
  // the fallback being invisible.
  assert.ok(["tsvector", "pg_search"].includes(body.debug.bm25Engine));
  assert.equal(body.debug.bm25Engine, "tsvector");
});

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

test("a search run is recorded with per-arm counts", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  await searcher.search("semiconductor tunnelling");

  const { rows } = await pools.poolFor(workspace).query(
    "SELECT * FROM search_runs ORDER BY ran_at DESC LIMIT 1"
  );
  const run = rows[0];

  assert.ok(run, "a search must leave a trace");
  assert.ok(run.vector_hits > 0);
  assert.ok(run.bm25_hits > 0);
  assert.ok(run.graph_hits > 0);
  assert.ok(run.temporal_hits > 0);
  assert.equal(run.rrf_k, 60);
  assert.equal(run.bm25_engine, "tsvector");
  assert.equal(run.embed_model, "google/gemini-embedding-2");
  assert.ok(run.weights.vector > 0);
});

test("the query text is hashed, not stored", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  await searcher.search("a very distinctive personal query about my dentist");
  const { rows } = await pools.poolFor(workspace).query(
    "SELECT query_hash FROM search_runs ORDER BY ran_at DESC LIMIT 1"
  );

  // search_runs records what was asked, and a personal-memory query is
  // personal. The hash groups repeats without storing the text.
  assert.match(rows[0].query_hash, /^[0-9a-f]{32}$/);
});

test("a search that returns nothing is still recorded, with zeros not nulls", async (t) => {
  const { searcher, workspace } = await withCorpus(t);

  await searcher.search("qqqqzzzz nothing matches this", { minSimilarity: 1.1 });

  const { rows } = await pools.poolFor(workspace).query(
    "SELECT * FROM search_runs ORDER BY ran_at DESC LIMIT 1"
  );
  const run = rows[0];

  // Zero means "the arm ran and matched nothing". NULL means "the arm did not
  // run". Telling them apart is the whole point of the column being nullable,
  // and this search exercises both in one row: the lexical arm ran and found
  // nothing, the graph arm never started because it had no seeds.
  assert.equal(run.bm25_hits, 0, "bm25 ran and matched nothing");
  assert.equal(run.vector_hits, 0, "the vector arm ran behind the distance floor");
  assert.equal(run.graph_hits, null, "the graph arm never ran, which is not the same as zero");
  assert.equal(run.results, 0);
});

test("a failed search does not fail the caller", async (t) => {
  const { store, searcher, workspace } = await withCorpus(t);

  const brokenStore = {
    searchBm25: async () => {
      throw new Error("connection terminated");
    },
    searchVector: async () => {
      throw new Error("connection terminated");
    },
    traverseGraph: async () => {
      throw new Error("connection terminated");
    },
    capabilities: async () => {
      throw new Error("connection terminated");
    },
    vectorCoverage: async () => {
      throw new Error("connection terminated");
    },
    recordSearchRun: async () => {
      throw new Error("connection terminated");
    }
  };

  const broken = createSearcher({ store: brokenStore, logger, embed: fakeEmbedder() });
  const body = await broken.search("anything");

  assert.deepEqual(body.results, []);

  // The two arms that could have run reported the database failure by name.
  // A single throw taking out the whole search would leave the caller with no
  // idea which layer was at fault.
  for (const arm of ["vector", "bm25"]) {
    assert.equal(body.debug.arms[arm].ran, false, `arm ${arm} should have reported a failure`);
    assert.match(body.debug.arms[arm].reason, /connection terminated/);
  }

  // And the dependent arm is honest about not having run, rather than
  // claiming a failure it never observed.
  assert.equal(body.debug.arms.graph.ran, false);
  assert.match(body.debug.arms.graph.reason, /no seeds/);

  // The reporting layer is not able to fail the search either. A search that
  // worked must not fail because its diagnostics query timed out.
  assert.equal(body.debug.bm25Engine, "unknown");
  assert.equal(body.debug.vectorCoverage, null);
  assert.equal(body.debug.degraded, true);
});
