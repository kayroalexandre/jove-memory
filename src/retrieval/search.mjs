import { createHash } from "node:crypto";

import { fuse, describeArms, DEFAULT_WEIGHTS, RRF_K } from "./rrf.mjs";
import { filterValidAt, rankTemporally, DEFAULT_HALF_LIFE_DAYS } from "./temporal.mjs";

/**
 * The four arms, fused.
 *
 * This module orchestrates; it does not query. Every SQL statement lives in
 * `src/store/store.mjs`, which is the project's only module that writes
 * queries, and every ranking decision lives in a sibling module that can be
 * tested without a database. What is left here is the order things happen in,
 * and that order is where most of the interesting failure modes are.
 *
 * The order:
 *
 *   1. Arm 1 (vector) and arm 2 (lexical) run against the query itself.
 *   2. Arm 3 (graph) needs seeds, and the seeds are whatever arms 1 and 2
 *      found. It cannot run first.
 *   3. Arm 4 (temporal) is a filter plus a reweighting over everything the
 *      first three returned, so it runs last.
 *   4. RRF fuses the four ranked lists.
 *
 * Every arm is independent of the others' failures. An embedding provider
 * that is down costs the vector arm and nothing else, and the response says
 * so in `debug.arms` — which is the difference between a degraded search and
 * a search that quietly got worse.
 */

/** How many candidates each arm contributes before fusion. */
const DEFAULT_ARM_LIMIT = 20;

export function createSearcher({ store, logger = null, weights = DEFAULT_WEIGHTS, embed = null }) {
  /**
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit]        final result count
   * @param {number} [options.asOf]         temporal filter reference (Date or ISO)
   * @param {string[]} [options.tags]
   * @param {string} [options.nodeId]
   * @param {number} [options.armLimit]     candidates per arm
   * @param {number} [options.graphDepth]
   * @param {string[]} [options.relations]  restrict graph traversal
   * @param {boolean} [options.includeDeleted]
   * @param {object} [options.weights]      per-arm override
   * @param {boolean} [options.persist]     write a search_runs row
   */
  async function search(query, options = {}) {
    const {
      limit = 20,
      asOf = null,
      tags = [],
      nodeId = null,
      armLimit = DEFAULT_ARM_LIMIT,
      // Passed straight to the vector arm. Null means no floor, which returns
      // the K nearest to anything at all — see the note on searchVector.
      minSimilarity = null,
      graphDepth = 2,
      relations = null,
      includeDeleted = false,
      includeInvalidated = false,
      persist = true,
      weights: weightOverride = null
    } = options;

    const activeWeights = { ...weights, ...(weightOverride ?? {}) };
    const started = Date.now();
    const trimmed = String(query ?? "").trim();

    // An empty query is a listing, not a failed search. Returning an error
    // would make the caller guess, and running four arms against "" produces
    // four meaningless rankings.
    if (!trimmed) {
      return emptyResult({
        query: trimmed,
        asOf,
        tookMs: Date.now() - started,
        reason: "empty query: this is a listing, not a search",
        weights: activeWeights
      });
    }

    // status records why an arm did not run. A zero hit count and a skipped
    // arm are different facts and the response must distinguish them.
    const status = {};
    const arms = {};

    // -- Arms 1 and 2, in parallel ------------------------------------------
    //
    // Parallel because they are independent, and because they are the two that
    // can be slow: one waits on an embedding provider, one waits on the
    // database. Running them in series doubles the latency of every search.

    const [vectorOutcome, lexicalOutcome] = await Promise.all([
      runVectorArm(embed, trimmed, { model: null }),
      runArm("bm25", () => store.searchBm25(trimmed, { limit: armLimit, nodeId, tags }))
    ]);

    arms.vector = vectorOutcome.results;
    status.vector = vectorOutcome.status;
    arms.bm25 = lexicalOutcome.results;
    status.bm25 = lexicalOutcome.status;

    // -- Seeds for the graph arm --------------------------------------------
    //
    // Whichever arms produced results become the seeds. A query that only the
    // lexical arm matched still gets a graph walk, because the point of the
    // graph arm is to find things that share no words with the query.

    const seeds = [...arms.vector, ...arms.bm25]
      .slice(0, Math.max(5, Math.floor(armLimit / 2)))
      .map((r) => r.id);

    if (seeds.length === 0) {
      status.graph = { ran: false, reason: "no seeds: arms 1 and 2 matched nothing" };
      status.temporal = { ran: false, reason: "no candidates to rank" };
    } else {
      const graphOutcome = await runArm("graph", () =>
        store.traverseGraph(seeds, { limit: armLimit, maxDepth: graphDepth, relations })
      );
      arms.graph = graphOutcome.results;
      status.graph = graphOutcome.status;

      // -- Arm 4: temporal -------------------------------------------------
      const pool = [...arms.vector, ...arms.bm25, ...arms.graph].filter(
        (r, i, all) => all.findIndex((o) => o.id === r.id) === i
      );

      const valid = filterValidAt(pool, asOf, { includeDeleted, includeInvalidated });
      const dropped = pool.length - valid.length;

      if (pool.length === 0) {
        status.temporal = { ran: false, reason: "no candidates" };
      } else if (asOf && valid.length === 0) {
        // Distinct from "the index was empty": the index had rows and none of
        // them were true at the requested moment. That is a real answer, and
        // a useful one — it means the caller is asking about a period nothing
        // covers.
        status.temporal = {
          ran: true,
          reason: `no item was true at ${asOf instanceof Date ? asOf.toISOString() : asOf}`
        };
      } else {
        status.temporal = { ran: true, reason: null };
        // Reweighted: recency modulates the existing rank rather than
        // replacing it. A fresh irrelevant item should not outrank an old
        // exact match, and pure recency ordering would do exactly that.
        arms.temporal = rankTemporally(valid, { at: asOf ?? new Date() }).map((entry) => ({
          id: entry.id,
          item: entry.item,
          recency: entry.temporal.recency,
          // Blend so recency moves an item but cannot dominate. 0.5 means a
          // perfectly recent item is worth half the arm's vote.
          score: entry.temporal.recency * (activeWeights.temporal ?? DEFAULT_WEIGHTS.temporal)
        }));
        if (dropped > 0) {
          status.temporal.dropped = dropped;
          status.temporal.reason = `${dropped} item(s) filtered out by the temporal filter`;
        }
      }
    }

    // -- Fuse ---------------------------------------------------------------

    const fused = fuse({ arms, weights: activeWeights, k: RRF_K });
    const armReport = describeArms(arms, activeWeights, status);

    // The gate: all four arms accounted for, with real values rather than
    // zeros. `describeArms` reports a skipped arm as `ran: false` with a
    // reason, so a fused result where two arms contributed nothing is
    // visible here rather than inferred from a suspiciously clean score.
    const allFourRan = Object.values(armReport).every((a) => a.ran);
    const allFourReported = Object.keys(armReport).length === 4;

    const tookMs = Date.now() - started;
    const results = fused.results.slice(0, limit);

    const response = {
      query: trimmed,
      asOf: asOf instanceof Date ? asOf.toISOString() : (asOf ?? null),
      results: results.map((r) => ({
        item: r.payload.item ?? r.payload,
        score: r.score,
        relative: r.relative,
        arms: r.arms,
        // Retained per-arm detail, because "which layer found this" is the
        // first question when a result looks wrong.
        detail: {
          similarity: r.payload.similarity ?? null,
          lexical: r.payload.normalised ?? null,
          graphDepth: r.payload.depth ?? null,
          relation: r.payload.relation ?? null,
          recency: r.payload.recency ?? null
        }
      })),
      debug: {
        fusion: { method: "rrf", k: fused.k, weights: activeWeights },
        arms: armReport,
        // Named explicitly because it is a real finding and not a detail: a
        // search that quietly ran on two layers is a search nobody is
        // measuring, and Phase 6's rerank benchmark depends on knowing it.
        degraded: !allFourRan,
        allLayersRan: allFourRan && allFourReported,
        bm25Engine: await bm25EngineOf(store),
        embedModel: arms.vector[0]?.embedModel ?? null,
        vectorCoverage: await safeReport(() => store.vectorCoverage(), logger),
        tookMs
      }
    };

    if (persist) {
      // Best-effort. A search that succeeded must not fail because its
      // accounting row did not write.
      await store
        .recordSearchRun({
          queryHash: hashQuery(trimmed),
          armHits: {
            vector: arms.vector.length,
            bm25: arms.bm25.length,
            graph: arms.graph?.length ?? null,
            temporal: arms.temporal?.length ?? null
          },
          weights: activeWeights,
          rrfK: fused.k,
          results: results.length,
          tookMs,
          bm25Engine: response.debug.bm25Engine,
          embedModel: response.debug.embedModel
        })
        .catch((err) => {
          logger?.warn("search accounting failed", { message: err.message });
        });
    }

    return response;

    // -----------------------------------------------------------------------

    /**
     * The vector arm, which is the only one that may leave the machine.
     *
     * Separated out because it is the only failure mode that is not a database
     * error, and the only one whose cost is money. A failure here is reported
     * as a skipped arm and the search continues on three layers.
     */
    async function runVectorArm(embedder, text, { model }) {
      if (!embedder) {
        return {
          results: [],
          // The honest reason. "embedder not configured" is Phase 3's actual
          // state — cloud embeddings arrive in Phase 4 — and saying so beats
          // an empty list that looks like a failed query.
          status: { ran: false, reason: "no embedder: this build has no embedding provider" }
        };
      }
      try {
        const embedded = await embedder.embed([text], { model, inputType: "query" });
        const vector = Array.isArray(embedded?.[0]) ? embedded[0] : embedded;
        if (!Array.isArray(vector)) {
          return { results: [], status: { ran: false, reason: "embedder returned no vector" } };
        }
        const found = await store.searchVector(vector, {
          limit: armLimit,
          model: embedded.model ?? null,
          minSimilarity
        });
        return { results: found, status: { ran: true, reason: null } };
      } catch (err) {
        // A provider outage degrades retrieval and does not fail the search
        // (ADR-008). The reason is recorded so the degradation is diagnosable
        // rather than mysterious.
        return {
          results: [],
          status: { ran: false, reason: `embedding failed: ${err.message}` }
        };
      }
    }

    /**
     * Run one database-backed arm, converting a thrown error into a reported
     * skip.
     *
     * A single arm failing is not a failed search. The other three still have
     * something to say, and the caller can decide whether three layers is
     * enough for what they asked.
     */
    async function runArm(name, fn) {
      try {
        return { results: await fn(), status: { ran: true, reason: null } };
      } catch (err) {
        return {
          results: [],
          status: { ran: false, reason: `${name} failed: ${err.message}` }
        };
      }
    }
  }

  return { search };
}

/** Which lexical engine is actually installed. Never assumed, never silent. */
async function bm25EngineOf(store) {
  try {
    const caps = await store.capabilities();
    return caps.bm25Engine;
  } catch {
    return "unknown";
  }
}

/**
 * A diagnostic that must not be able to fail the search.
 *
 * Coverage and engine identity are reporting, not retrieval. A caller whose
 * search worked does not care that the reporting query timed out, but a
 * caller reading `debug` needs to know the number is absent rather than zero.
 */
async function safeReport(fn, logger) {
  try {
    return await fn();
  } catch (err) {
    logger?.warn("search diagnostics unavailable", { message: err.message });
    return null;
  }
}

function hashQuery(query) {
  // sha256 rather than the raw query: search_runs records what was asked, and
  // a personal-memory query is personal. The hash groups repeats without
  // storing the text.
  return createHash("sha256").update(query).digest("hex").slice(0, 32);
}

function emptyResult({ query, asOf, tookMs, reason, weights }) {
  return {
    query,
    asOf: asOf instanceof Date ? asOf.toISOString() : (asOf ?? null),
    results: [],
    debug: {
      fusion: { method: "rrf", k: RRF_K, weights },
      arms: Object.fromEntries(
        Object.keys(DEFAULT_WEIGHTS).map((arm) => [arm, { ran: false, reason, hits: 0, weight: weights[arm] }])
      ),
      degraded: true,
      allLayersRan: false,
      tookMs
    }
  };
}

export { DEFAULT_HALF_LIFE_DAYS, fuse, describeArms, RRF_K, DEFAULT_WEIGHTS };
