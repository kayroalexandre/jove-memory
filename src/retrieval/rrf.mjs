/**
 * Reciprocal rank fusion.
 *
 * Four arms produce four rankings whose scores are not comparable: cosine
 * similarity is roughly 0..1, `ts_rank` is unbounded, a graph hop count is a
 * small integer, and a temporal decay is exponential. Normalising them onto
 * one scale needs per-query calibration, and that calibration is the thing
 * that breaks on small result sets — exactly the personal-memory case, where
 * a query often matches three items.
 *
 * RRF sidesteps the whole problem by ignoring scores entirely. Each arm
 * contributes `weight / (k + rank)` for the items it ranked, and the sums are
 * added. Only ordinal information crosses the boundary.
 *
 * `k` matters and is not a tuning knob picked by feel. Small `k` makes the
 * top of each list dominate; large `k` flattens the curve so the tenth result
 * counts almost as much as the first. 60 is the value from Cormack, Clarke
 * and Buettcher's 2009 paper, and it is deliberately not changed — a value
 * that is retuned per deployment is a value that differs between two runs of
 * "the same" search, which is worse than a known constant.
 *
 * Pure module. No database, no I/O, no config import — which is what makes it
 * testable on its own and what keeps the fusion honest.
 */

/** The constant from the RRF paper. Not a tuning knob; see above. */
export const RRF_K = 60;

export const DEFAULT_WEIGHTS = Object.freeze({
  vector: 1.0,
  bm25: 1.0,
  graph: 0.7,
  temporal: 0.5
});

/**
 * Fuse ranked lists.
 *
 * @param {object} input
 * @param {Object<string, Array<{id: string}>>} input.arms
 *   One entry per arm, each an array of results already ordered best-first.
 *   Rank is the array index. An arm that is absent, empty, or explicitly
 *   disabled contributes nothing — that is different from contributing zeros,
 *   and the difference is reported in the result's `arms` block.
 * @param {Record<string, number>} [input.weights]
 *   Per-arm multiplier. A weight of 0 disables the arm without removing it,
 *   so the debug block still shows what it would have contributed. This is
 *   how a failed embedding provider degrades: the arm is reported as
 *   `skipped`, not silently absent.
 * @param {number} [input.k]
 * @returns {object}
 */
export function fuse({ arms, weights = DEFAULT_WEIGHTS, k = RRF_K }) {
  if (!arms || typeof arms !== "object") {
    throw new TypeError("fuse() needs an arms object");
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`RRF k must be a positive number, got ${k}`);
  }

  /** item id -> accumulated score and per-arm detail. */
  const fused = new Map();

  for (const [arm, results] of Object.entries(arms)) {
    const weight = weights[arm];
    if (!Array.isArray(results)) continue;

    // A weight of 0 is a deliberate exclusion, not an accident. Recording it
    // as zeroed keeps the arm's results visible in the report without letting
    // them affect the order.
    const zeroed = weight === 0;

    // enumerate, not map+index: rank must be 1-based to match the formula, and
    // the denominator is per-result. Hoisting the division out of the loop
    // is a plausible-looking optimisation that silently makes every rank in
    // an arm score as if it were first.
    for (const [index, result] of results.entries()) {
      const id = result.id;
      if (id === undefined || id === null) continue;

      let entry = fused.get(id);
      if (!entry) {
        entry = { id, score: 0, arms: {}, payload: result };
        fused.set(id, entry);
      }

      // A later arm's payload does not overwrite an earlier one's. The first
      // arm to surface an item owns the row that gets returned, and which arm
      // that is depends on nothing but the arm order above.
      if (result.item !== undefined && entry.payload.item === undefined) {
        entry.payload = result;
      }

      const rank = index + 1;
      if (zeroed) {
        entry.arms[arm] = { rank, weight: 0, contribution: 0, zeroed: true };
        continue;
      }

      // The contribution this arm makes, computed for the report as well as
      // for the sum. A result whose debug block says where its score came
      // from is worth the one line.
      const contribution = (weight ?? 0) / (k + rank);
      entry.score += contribution;
      entry.arms[arm] = { rank, weight, contribution, zeroed: false };
    }
  }

  const results = [...fused.values()];

  // Ties broken by id, ascending. Without this the order of equal-scoring
  // results depends on Map insertion order, which depends on arm order, which
  // looks stable until one arm returns a different set. The Phase 3 gate
  // requires the same query to give the same ordering ten times running; this
  // line is what makes that true rather than usually true.
  results.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const best = results[0]?.score ?? 0;
  return {
    results: results.map((r) => ({
      id: r.id,
      score: r.score,
      // Normalised for readability only. Never used for ordering and never
      // fed back into a threshold — a threshold on a rank-relative number
      // means something different at every result count.
      relative: best > 0 ? r.score / best : 0,
      arms: r.arms,
      payload: r.payload
    })),
    k
  };
}

/**
 * Which arms actually ran, and why not if they did not.
 *
 * A `debug` block that shows four arms with zeros is indistinguishable from
 * one that shows four arms and finds nothing. The difference decides whether
 * a bad result is a bad index or a bad query, so the distinction is the whole
 * point of the report.
 *
 * @param {Object<string, Array>} arms
 * @param {Record<string, number>} weights
 * @param {Record<string, {ran: boolean, reason?: string, hits?: number}>} status
 *   Per-arm execution status, supplied by the caller. An arm not named here
 *   is inferred from whether it returned results.
 */
export function describeArms(arms = {}, weights = DEFAULT_WEIGHTS, status = {}) {
  const report = {};

  for (const arm of Object.keys(DEFAULT_WEIGHTS)) {
    const results = Array.isArray(arms[arm]) ? arms[arm] : null;
    const explicit = status[arm];

    if (explicit && explicit.ran === false) {
      report[arm] = {
        ran: false,
        reason: explicit.reason ?? "did not run",
        hits: 0,
        weight: weights[arm] ?? 0
      };
      continue;
    }

    if (results === null) {
      report[arm] = {
        ran: false,
        reason: "not attempted",
        hits: 0,
        weight: weights[arm] ?? 0
      };
      continue;
    }

    report[arm] = {
      ran: true,
      // Distinct from hits === 0. Zero hits means the arm ran and the index
      // had nothing; that is information about the data.
      hits: results.length,
      weight: weights[arm] ?? 0
    };
  }

  return report;
}
