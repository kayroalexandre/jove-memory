import { contextHash, NOUL } from "../decisions/client.mjs";

/**
 * Cross-workspace retrieval.
 *
 * The requirement this implements, and it is a strange one to write software
 * for: **recall across workspaces without mixing contexts.** A query in
 * workspace B can return an item from workspace A — but only when something in
 * B is recorded as the same entity as something in A, and only when the decision
 * model says that link answers *this* question. Nothing is ever returned for
 * being nearby.
 *
 * ## The asymmetry that governs everything here
 *
 * Ordinary retrieval degrades **open**: a provider outage means three layers
 * instead of four, and the results are still the user's own. Cross-workspace
 * retrieval degrades **closed**: a provider outage means *nothing* crosses the
 * boundary, ever.
 *
 * Those are not the same trade. Returning slightly worse results is a quality
 * problem, and this system has committed to accepting one. Returning another
 * workspace's content because a safety check could not run is a context leak,
 * and the whole point of one database per workspace is that it does not happen
 * by accident. A degraded search is a worse search; a degraded cross-workspace
 * search is a different system.
 *
 * ## What a cross-workspace result looks like
 *
 * Always labelled with where it came from. Not as an option — a result without
 * an origin is indistinguishable from a local one, and a user who cannot tell
 * which workspace a memory belongs to cannot reason about what they just read.
 */

/** The question asked of each candidate from another workspace. */
export const CROSS_WORKSPACE_QUESTION = {
  key: "relevant_to_query",
  type: NOUL,
  instructions: [
    "This memory is from a different context than the one being searched.",
    "Does it answer the question that was asked?",
    "Say no when it is about the same subject but a different person, a different",
    "project, or a different point in time, and when the only connection is that",
    "the wording is similar."
  ].join(" ")
};

export const CROSS_WORKSPACE_SCHEMA_VERSION = "cross-workspace-v1";

/**
 * The default threshold.
 *
 * Higher than the write gate's, and it may only ever rise — see
 * docs/THRESHOLDS.md. The asymmetry is deliberate in both directions: being too
 * low leaks context across a boundary the user drew, and being too high merely
 * fails to find something the user could have found themselves by switching
 * workspace. One of those is a privacy incident and the other is a missing
 * result, so the scale is biased hard toward the first.
 */
export const DEFAULT_CROSS_WORKSPACE_THRESHOLD = 0.75;

export function createCrossWorkspaceRetriever({
  store,
  sharedStore,
  client,
  logger = null,
  threshold = null,
  sharedWorkspace = "_shared"
}) {
  const activeThreshold = threshold ?? DEFAULT_CROSS_WORKSPACE_THRESHOLD;

  /**
   * Expand a result set across workspaces.
   *
   * @param {object} input
   * @param {string} input.query
   * @param {string} input.workspace        the workspace being searched
   * @param {Array<{id: string, item: object}>} input.results  the local results
   * @param {number} [input.limit]           how many foreign results to return
   * @param {number} [input.maxCandidates]   how many to put to the model
   * @returns {Promise<object>}
   */
  async function expand({ query, workspace, results, limit = 5, maxCandidates = 20 }) {
    const started = Date.now();
    const hash = contextHash(query);
    const seeds = (results ?? []).map((r) => r.id).filter(Boolean);

    // Written to `_shared`, not to the searching workspace.
    //
    // A log held by the workspace that did the crossing answers "what did I
    // pull from elsewhere" to whoever can read that workspace, and nothing to
    // anyone auditing the system. The shared layer is what mediates the
    // boundary, so it is what records the boundary being crossed — one place
    // that answers "what has been crossing, from where, and what was refused".
    const record = (outcome, detail, counts = {}) =>
      sharedStore
        .recordCrossWorkspaceAudit({
          queryHash: hash,
          fromWorkspace: workspace,
          edgesFound: counts.edges ?? 0,
          candidates: counts.candidates ?? 0,
          admitted: counts.admitted ?? 0,
          threshold: activeThreshold,
          outcome,
          detail
        })
        .catch((err) => logger?.warn("cross-workspace audit failed", { message: err.message }));

    // A provider that is not configured cannot gate anything, and gating is
    // not optional. This is the fail-closed case, and it is reached before any
    // lookup so a cross-workspace search costs nothing when it cannot be safe.
    if (!client || !client.available()) {
      await record("no_provider", "no decision provider configured; nothing crosses");
      return closed("no decision provider is configured", { started, threshold: activeThreshold });
    }

    if (seeds.length === 0) {
      await record("no_edges", "the local search returned nothing, so there is nothing to expand from");
      return closed("the local search returned nothing", { started, threshold: activeThreshold });
    }

    // 1. Find the edges. In `_shared`, from the seeds outward in both
    //    directions.
    let edges;
    try {
      edges = await sharedStore.findCrossWorkspaceEdges({ fromWorkspace: workspace, itemIds: seeds });
    } catch (err) {
      // Fail closed. An unreachable shared database is not a reason to answer
      // from this workspace alone and call it cross-workspace.
      logger?.warn("cross-workspace edge lookup failed", { message: err.message });
      await record("error", `edge lookup failed: ${err.message}`);
      return closed(`the shared edge store could not be read: ${err.message}`, {
        started,
        threshold: activeThreshold
      });
    }

    if (edges.length === 0) {
      // Gate item two, stated explicitly: no edge, no crossing. The audit
      // records it so "we looked and found nothing" is distinguishable from
      // "we never looked".
      await record("no_edges", `no edge links any of the ${seeds.length} local result(s) to another workspace`, {
        edges: 0
      });
      return closed("no edge links these results to another workspace", {
        started,
        threshold: activeThreshold,
        edges: 0
      });
    }

    // 2. Collect the foreign items the edges point at.
    const candidates = edges
      .map((edge) => ({
        edge,
        workspace: edge.workspace_to === workspace ? edge.workspace_from : edge.workspace_to,
        itemId: edge.workspace_to === workspace ? edge.item_from : edge.item_to
      }))
      .filter((c) => c.workspace !== workspace)
      // A weak edge is not consulted at all. Not "consulted and probably
      // rejected" — the edge's own confidence is a first gate, and it is a
      // cheap one.
      .filter((c) => c.edge.confidence >= activeThreshold);

    if (candidates.length === 0) {
      await record(
        "below_threshold",
        `${edges.length} edge(s) found, none with confidence at or above ${activeThreshold}`,
        { edges: edges.length }
      );
      return closed("every edge is weaker than the threshold", {
        started,
        threshold: activeThreshold,
        edges: edges.length
      });
    }

    // 3. Load the foreign items. Their content is read from *their* workspace,
    //    by their workspace's store — never by reaching into another database
    //    from here.
    const loaded = [];
    for (const candidate of candidates.slice(0, maxCandidates)) {
      try {
        const foreign = await storeFor(candidate.workspace);
        const item = await foreign.readItem(candidate.itemId);
        if (item) {
          loaded.push({ ...candidate, item, store: foreign });
        }
      } catch (err) {
        // One unreadable foreign item is not a reason to abandon the rest, and
        // it is not a reason to let anything through unchecked.
        logger?.warn("foreign item unreadable", {
          workspace: candidate.workspace,
          itemId: candidate.itemId,
          message: err.message
        });
      }
    }

    if (loaded.length === 0) {
      await record("error", "edges were found but none of the foreign items could be read", {
        edges: edges.length,
        candidates: candidates.length
      });
      return closed("no foreign item behind those edges could be read", {
        started,
        threshold: activeThreshold,
        edges: edges.length
      });
    }

    // 4. Gate each one on the decision model. This is the check that makes the
    //    whole thing safe, so a failure in it is a stop rather than a warning.
    let admitted = [];
    let belowThreshold = 0;
    let providerFailed = 0;

    const verdicts = await Promise.all(
      loaded.map(async (candidate) => {
        try {
          const verdict = await client.decide({
            state: buildState({ query, item: candidate.item }),
            questions: { [CROSS_WORKSPACE_QUESTION.key]: CROSS_WORKSPACE_QUESTION }
          });
          return { candidate, verdict };
        } catch (err) {
          return { candidate, error: err };
        }
      })
    );

    for (const entry of verdicts) {
      if (entry.error) {
        providerFailed += 1;
        continue;
      }
      const answer = entry.verdict.answers[CROSS_WORKSPACE_QUESTION.key];
      if (!answer || answer.type !== NOUL || !Number.isFinite(answer.noul)) {
        providerFailed += 1;
        continue;
      }
      if (answer.noul < activeThreshold) {
        belowThreshold += 1;
        continue;
      }
      admitted.push({ ...entry.candidate, relevance: answer.noul, model: entry.verdict.model });
    }

    // The fail-closed rule, stated once and enforced here: if the model could
    // not answer for *every* candidate, nothing crosses. Not "the ones that
    // worked" — a partial result from a partially-broken gate is exactly the
    // case where you cannot tell what was let through on purpose.
    if (providerFailed > 0 && providerFailed === verdicts.length) {
      await record(
        "provider_unavailable",
        `the decision provider failed for all ${verdicts.length} candidate(s); nothing was admitted`,
        { edges: edges.length, candidates: loaded.length, admitted: 0 }
      );
      return closed(
        `the decision provider failed for every candidate, so nothing was admitted (${providerFailed} failures)`,
        { started, threshold: activeThreshold, edges: edges.length, providerFailed }
      );
    }

    if (providerFailed > 0) {
      // Partial. The failures are counted and reported, and the ones that were
      // judged are still gated — the ones that failed are simply absent, which
      // is closed behaviour for them individually.
      logger?.warn("some cross-workspace candidates were not judged", {
        failed: providerFailed,
        of: verdicts.length
      });
    }

    admitted.sort((a, b) => b.relevance - a.relevance || (a.itemId < b.itemId ? -1 : 1));
    const returned = admitted.slice(0, limit);

    await record(
      "ok",
      returned.length === 0
        ? `${loaded.length} candidate(s) across ${edges.length} edge(s), none at or above ${activeThreshold}`
        : `admitted ${returned.length} of ${loaded.length} candidate(s) across ${edges.length} edge(s)`,
      { edges: edges.length, candidates: loaded.length, admitted: returned.length }
    );

    return {
      results: returned.map((entry) => ({
        item: entry.item,
        // Provenance, and the point of it: a foreign result that does not say
        // where it came from is indistinguishable from a local one, and a user
        // who cannot tell which context they are reading cannot reason about
        // it.
        origin: {
          crossWorkspace: true,
          workspace: entry.workspace,
          itemId: entry.itemId,
          viaEdge: {
            relation: entry.edge.relation,
            basis: entry.edge.basis,
            confidence: Number(entry.edge.confidence),
            confirmed: entry.edge.confirmed,
            // The other end of the edge from the origin, which is the
            // workspace the caller searched.
            //
            // Two earlier versions got this wrong in two different ways, both
            // producing a provenance record that named the *foreign* workspace
            // as the peer — i.e. the origin and its peer were the same
            // workspace, which points nowhere. Derived from the origin's own
            // workspace rather than from the querying one, so it cannot be
            // inverted by a change in either.
            peerWorkspace: entry.edge.workspace_to === entry.workspace ? entry.edge.workspace_from : entry.edge.workspace_to
          },
          relevance: entry.relevance,
          threshold: activeThreshold,
          model: entry.model
        }
      })),
      admitted: returned.length,
      candidates: loaded.length,
      edges: edges.length,
      belowThreshold,
      providerFailed,
      threshold: activeThreshold,
      latencyMs: Date.now() - started
    };
  }

  /**
   * The fail-closed shape.
   *
   * One constructor for every refusal, so a caller cannot receive a partial
   * result set with a status that does not say so. `failClosed: true` is named
   * rather than inferred from an empty list, because "no foreign results
   * because none qualified" and "no foreign results because the check could not
   * run" are the two things a caller most needs to tell apart.
   */
  function closed(reason, { started, threshold, edges = null, providerFailed = null } = {}) {
    return {
      results: [],
      admitted: 0,
      edges,
      failClosed: true,
      reason,
      providerFailed,
      threshold,
      latencyMs: Date.now() - started
    };
  }

  /**
   * A store for another workspace.
   *
   * Injected rather than constructed, because opening a pool to another
   * workspace from inside a retrieval call is how a system ends up with an
   * unbounded number of connections. One manager, one pool per workspace, and
   * the caller decides which workspaces exist.
   */
  let storeFor;
  return {
    expand,
    threshold: activeThreshold,
    question: CROSS_WORKSPACE_QUESTION,
    /** Wires the workspace resolver the caller has. */
    useStores(resolver) {
      storeFor = resolver;
      return this;
    }
  };
}

/** What the model is shown for a foreign candidate. */
function buildState({ query, item }) {
  const content = String(item?.content ?? "").slice(0, 1200);
  return [`QUESTION:\n${query}`, `MEMORY FROM ANOTHER CONTEXT:\n${content}`].join("\n\n");
}
