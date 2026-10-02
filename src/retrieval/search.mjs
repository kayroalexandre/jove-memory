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

export function createSearcher({
  store,
  logger = null,
  weights = DEFAULT_WEIGHTS,
  embed = null,
  rerank = null
}) {
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
      weights: weightOverride = null,
      // Rerank is opt-out. Off by default here because a search that calls a
      // third-party model per candidate adds seconds to every query; Phase 6
      // turns it on for the paths where that is worth it.
      rerank: rerankRequested = false,
      rerankTopK = 20
    } = options;

    const activeWeights = { ...weights, ...(weightOverride ?? {}) };
    const started = Date.now();
    const trimmed = String(query ?? "").trim();

    /**
     * The text the non-vector arms work from.
     *
     * For an image query that is the caption, not the empty `query`. A
     * caption is real text with real vocabulary, and running the lexical and
     * graph arms against it is the difference between a picture search using
     * three layers and one using one.
     */
    const lexicalQuery = trimmed || (options.caption ? String(options.caption).trim() : "");

    // An empty query is a listing, not a failed search. Returning an error
    // would make the caller guess, and running four arms against "" produces
    // four meaningless rankings.
    //
    // An image query has no text and is not a listing. The two are different
    // requests that both arrive with an empty `query`, which is exactly the
    // case that makes this check worth reading carefully: treating an image
    // query as a listing would silently return nothing for every picture ever
    // uploaded, and nothing in the response would say why.
    if (!trimmed && !options.imageUrl) {
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

    // A missing provider is not a provider failure. The distinction is the
    // point of `semantic_error`: one means "we asked and it did not work", the
    // other means "we never asked", and a caller reacting to the first (alert,
    // retry, fail the request) would be wrong for the second.
    const NOT_CONFIGURED = "no embedder: this build has no embedding provider";

    /**
     * How the vector arm gets its query vector.
     *
     * A closure rather than a branch, which is what lets a text query and an
     * image query share every line below. An image is embedded in the *same*
     * space as text (ADR-005), so from the vector arm's point of view the only
     * difference is how the vector was produced — and the reason there is no
     * image index to consult, no second embedding space, and no query
     * classifier choosing between them.
     */
    const produceVector = options.imageUrl
      ? () => embedImage(embed, options.imageUrl, options.caption ?? "")
      : () => embedText(embed, trimmed);

    // -- Arms 1 and 2, in parallel ------------------------------------------
    //
    // Parallel because they are independent, and because they are the two that
    // can be slow: one waits on an embedding provider, one waits on the
    // database. Running them in series doubles the latency of every search.

    const [vectorOutcome, lexicalOutcome] = await Promise.all([
      runVectorArm(produceVector, minSimilarity, armLimit),
      // A query with no text has no lexical comparison to make. Skipping is
      // honest; running the arm against an empty string would report hits from
      // no comparison at all, which is the failure mode this whole `status`
      // object exists to prevent.
      lexicalQuery
        ? runArm("bm25", () => store.searchBm25(lexicalQuery, { limit: armLimit, nodeId, tags }))
        : {
            results: [],
            status: { ran: false, reason: "no text in the query to match lexically" }
          }
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

    // -- Rerank, over the fused shortlist ----------------------------------
    //
    // After fusion, not instead of it. The four arms decide *which* memories
    // are candidates; rerank only reorders that set. Reranking before fusion
    // would let one arm's opinion reorder another arm's results, which is the
    // exact thing fusing exists to prevent.
    let final = fused.results;
    let rerankReport = { ranked: false, reason: "not requested" };

    if (rerankRequested) {
      const outcome = await rerank({
        query: trimmed,
        results: fused.results.slice(0, rerankTopK),
        topK: rerankTopK
      });
      final = [...outcome.results, ...fused.results.slice(rerankTopK)];
      rerankReport = {
        ranked: outcome.ranked,
        reason: outcome.reason,
        unranked: outcome.unranked ?? 0,
        cost: outcome.cost ?? 0,
        latencyMs: outcome.latencyMs ?? 0
      };
    }

    const tookMs = Date.now() - started;
    const results = final.slice(0, limit);

    const response = {
      query: trimmed,
      // Present because `query: ""` on an image query reads as "the search
      // did not happen". Naming the type says "no text" rather than "no
      // query", and it is the field a client switches on to render a result
      // set that came from a picture.
      queryType: options.imageUrl ? "image" : "text",
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
          recency: r.payload.recency ?? null,
          // The decision model's verdict, when there was one. Present and null
          // is different from absent: null means "this candidate was not
          // judged", and a caller reading `rerank` cannot otherwise tell that
          // from "the field is from an older build".
          rerank: r.rerank ?? null,
          rerankReason: r.rerankReason ?? null
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
        /**
         * The vector arm's failure, named as a single field.
         *
         * `null` means the semantic layer ran. Non-null means it did not, and
         * the value says why in one place rather than requiring the reader to
         * reconstruct it from `arms.vector`.
         *
         * This is the field Phase 4's gate greps for: a response containing
         * `semantic_error` is a search that ran on three layers, whatever the
         * result count looks like. Making it a named field is what turns
         * "did the semantic layer work" from a judgement into a check.
         *
         * A missing provider is not a failure, so it is not reported as one.
         * The two call for opposite responses: an error here means retry or
         * page someone, an unconfigured provider means nobody has issued a key
         * yet, and alerting about the second is how a real outage gets ignored
         * as a known one.
         */
        semantic_error:
          status.vector?.ran === false && status.vector.configured !== false
            ? status.vector.reason
            : null,
        /**
         * Whether an embedding provider is configured at all.
         *
         * Separate from `semantic_error` because "not configured" and "failed"
         * need different reactions, and because this is a property of the
         * deployment rather than of any one search.
         */
        semantic_configured: status.vector?.configured !== false,
        /**
         * Rerank, reported separately from the fusion.
         *
         * `ranked: false` with a reason is the important case: the results are
         * in RRF order and the caller is told so. A search that quietly returns
         * unranked results while claiming to be ranked is the failure this
         * field exists to make impossible.
         */
        rerank: rerankReport,
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
     * as a skipped arm and the search continues on three layers (ADR-008).
     *
     * Takes a producer rather than a string, so a text query and an image
     * query are the same code from here down.
     */
    async function runVectorArm(produce, floor, limit) {
      if (!embed) {
        return {
          results: [],
          // The honest reason. A build with no embedder configured is a real
          // state — it is what CI runs, and what Phase 3 ran before the
          // embedder existed — and saying so beats an empty list that looks
          // like a failed query.
          status: { ran: false, reason: NOT_CONFIGURED, configured: false }
        };
      }
      try {
        const vector = await produce();
        if (!Array.isArray(vector)) {
          return { results: [], status: { ran: false, reason: "embedder returned no vector", configured: true } };
        }
        const found = await store.searchVector(vector, {
          limit,
          // The active model's vectors only. Filtering by model is what stops
          // an index holding two models' vectors from returning distances
          // between incomparable numbers (ADR-005).
          model: embed.model ?? null,
          minSimilarity: floor
        });
        return { results: found, status: { ran: true, reason: null, configured: true } };
      } catch (err) {
        // A provider outage degrades retrieval and does not fail the search
        // (ADR-008). The reason is recorded so the degradation is diagnosable
        // rather than mysterious.
        return {
          results: [],
          status: { ran: false, reason: `embedding failed: ${err.message}`, configured: true }
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

/**
 * Produce a query vector from text.
 *
 * `input_type: "query"` is not decoration. Several embedding models are
 * asymmetric: the same string embedded as a query and as a passage lands in
 * meaningfully different places, and retrieving a corpus with a passage-shaped
 * query vector is a systematic error that looks like mediocre ranking rather
 * than a bug.
 *
 * The model decides whether it wants this. `google/gemini-embedding-2` ignores
 * it; NVIDIA's `nemotron-3-embed-1b` requires it, taking `query` or `passage`.
 */
async function embedText(embedder, text) {
  const embedded = await embedder.embed([text], { inputType: "query" });
  return embedded[0];
}

/**
 * Produce a query vector from an image, with optional caption.
 *
 * The caption and the image go in the same request, so the result is a joint
 * embedding rather than two separate ones averaged afterwards. That matters:
 * averaging two vectors from the same space is not the same as embedding the
 * pair jointly, and the API supports the joint form directly.
 *
 * No caption means the request is image-only, which the API accepts — the
 * content array needs at least one part, and an image is one.
 */
async function embedImage(embedder, imageUrl, caption) {
  const parts = [];
  if (caption) parts.push({ type: "text", text: caption });
  parts.push({ type: "image_url", image_url: { url: imageUrl } });

  if (typeof embedder.embedContent !== "function") {
    throw new Error(
      "The configured embedder has no embedContent(). An image query needs the " +
        "multimodal path, and there is no local fallback (ADR-009)."
    );
  }
  return embedder.embedContent(embedder.contentInput(parts), { inputType: "query" });
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
    queryType: "text",
    asOf: asOf instanceof Date ? asOf.toISOString() : (asOf ?? null),
    results: [],
    debug: {
      fusion: { method: "rrf", k: RRF_K, weights },
      arms: Object.fromEntries(
        Object.keys(DEFAULT_WEIGHTS).map((arm) => [arm, { ran: false, reason, hits: 0, weight: weights[arm] }])
      ),
      degraded: true,
      allLayersRan: false,
      // An empty query is not a semantic failure. Nothing was embedded
      // because nothing was asked, and reporting it as an error would make the
      // gate for "the semantic layer worked" impossible to read.
      semantic_error: null,
      semantic_configured: true,
      tookMs
    }
  };
}

export { DEFAULT_HALF_LIFE_DAYS, fuse, describeArms, RRF_K, DEFAULT_WEIGHTS };
