import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCrossWorkspaceRetriever,
  CROSS_WORKSPACE_QUESTION,
  DEFAULT_CROSS_WORKSPACE_THRESHOLD
} from "../src/retrieval/cross-workspace.mjs";
import { NOUL } from "../src/decisions/client.mjs";

/**
 * Cross-workspace retrieval, and the four properties the gate names.
 *
 *   1. A query in B returns an item from A only through a real edge
 *   2. Zero results cross when no edge exists
 *   3. Every cross-workspace result is labelled with its origin
 *   4. With the provider down, **nothing** crosses — fail closed
 *
 * The fourth is the one that matters and the one most likely to be got wrong,
 * because the instinct everywhere else in this system is to degrade open. Here
 * the instinct is exactly backwards, and the tests are written so that a
 * "helpful" fallback to returning unverified foreign content would fail.
 */

const WORKSPACE = "work";
const OTHER = "personal";

/** Rows the shared store recorded. Reset by each `build`. */
let audits = [];

const item = (id, content, extra = {}) => ({
  id,
  node_id: "n",
  content,
  status: "active",
  importance: 0.5,
  confidence: 0.8,
  tags: [],
  created_at: "2026-01-01T00:00:00Z",
  ...extra
});

/** A client that approves above 0.5 and refuses below, unless told otherwise. */
function client({ noul = 0.9, fail = false, failFor = null, available = true } = {}) {
  const calls = [];
  return {
    calls,
    model: "upstage/solar-decide",
    available: () => available,
    async decide({ state }) {
      const memory = state.split("MEMORY FROM ANOTHER CONTEXT:\n")[1] ?? "";
      if (fail || (failFor && memory.includes(failFor))) {
        throw new Error("provider unavailable");
      }
      const value = typeof noul === "function" ? noul(state) : noul;
      calls.push(state);
      return {
        answers: { [CROSS_WORKSPACE_QUESTION.key]: { type: NOUL, noul: value, inRange: true } },
        model: "upstage/solar-decide-20260901",
        requestedModel: "upstage/solar-decide",
        cost: 0.00001,
        latencyMs: 1
      };
    }
  };
}

/** A shared store holding the edges, and a per-workspace item reader. */
function stores({ edges = [], items = {} } = {}) {
  return {
    sharedStore: {
      async recordCrossWorkspaceAudit(row) {
        audits.push(row);
      },
      async findCrossWorkspaceEdges({ fromWorkspace, itemIds }) {
        return edges.filter(
          (edge) =>
            (edge.workspace_from === fromWorkspace && itemIds.includes(edge.item_from)) ||
            (edge.workspace_to === fromWorkspace && itemIds.includes(edge.item_to))
        );
      }
    },
    resolver: (workspace) => ({
      async readItem(id) {
        return items[`${workspace}/${id}`] ?? null;
      }
    })
  };
}

function build({ edges = [], items = {}, ...clientOptions } = {}) {
  const auditRows = [];
  const { sharedStore, resolver } = stores({ edges, items });
  audits = auditRows;
  // A store that would fail loudly if the audit were written to the wrong
  // place. It is a shared-layer record; a workspace's own log of what it pulled
  // from elsewhere is auditable by nobody else.
  const localStore = {
    async recordCrossWorkspaceAudit() {
      throw new Error("the cross-workspace audit belongs in _shared, not in the searching workspace");
    }
  };

  const decision = client(clientOptions);
  const retriever = createCrossWorkspaceRetriever({
    store: localStore,
    sharedStore,
    client: decision,
    threshold: clientOptions.threshold
  });
  retriever.useStores(resolver);

  return { retriever, decision, auditRows, store: localStore };
}

const edge = (over = {}) => ({
  id: "e1",
  workspace_from: WORKSPACE,
  item_from: "local-1",
  workspace_to: OTHER,
  item_to: "foreign-1",
  relation: "same_entity",
  basis: "entity",
  confidence: 1,
  confirmed: true,
  ...over
});

const expand = (retriever, results = [{ id: "local-1", item: item("local-1", "a local memory") }], options = {}) =>
  retriever.expand({ query: "who is Bia?", workspace: WORKSPACE, results, ...options });

// ---------------------------------------------------------------------------
// Gate 1 and 2: an edge, or nothing
// ---------------------------------------------------------------------------

test("with no edge, nothing crosses — and the refusal is recorded", async () => {
  const { retriever, auditRows } = build({ edges: [], items: {} });
  const out = await expand(retriever);

  assert.deepEqual(out.results, []);
  assert.equal(out.edges, 0);
  assert.equal(out.failClosed, true, "and named, not an empty list that means anything");

  // The audit distinguishes "we looked and found nothing" from "we never
  // looked", which a result list cannot.
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].outcome, "no_edges");
  assert.equal(auditRows[0].admitted, 0);
});

test("the decision model is never asked when there is no edge", async () => {
  // Not merely "nothing was returned" — the gate is not consulted at all, so
  // no cost is spent and no foreign content is even read.
  const { retriever, decision } = build({ edges: [] });
  await expand(retriever);
  assert.equal(decision.calls.length, 0);
});

test("a real edge lets a relevant foreign item through, labelled with its origin", async () => {
  const { retriever } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "Bia is six years old") }
  });

  const out = await expand(retriever);

  assert.equal(out.results.length, 1);
  const result = out.results[0];
  assert.equal(result.item.content, "Bia is six years old");
  assert.equal(result.origin.crossWorkspace, true);
  assert.equal(result.origin.workspace, OTHER, "which workspace it came from");
  assert.equal(result.origin.viaEdge.relation, "same_entity");
  assert.equal(result.origin.viaEdge.confidence, 1);
  assert.equal(result.origin.viaEdge.confirmed, true);
  assert.equal(result.origin.viaEdge.peerWorkspace, WORKSPACE);
  assert.ok(result.origin.relevance >= DEFAULT_CROSS_WORKSPACE_THRESHOLD);
});

test("every cross-workspace result carries its origin", async () => {
  // A result without an origin is indistinguishable from a local one, and a
  // user who cannot tell which context they are reading cannot reason about it.
  const { retriever } = build({
    edges: [
      edge(),
      edge({ id: "e2", item_to: "foreign-2", item_from: "local-2" })
    ],
    items: {
      [`${OTHER}/foreign-1`]: item("foreign-1", "one"),
      [`${OTHER}/foreign-2`]: item("foreign-2", "two")
    }
  });

  const out = await expand(retriever, [
    { id: "local-1", item: item("local-1", "a") },
    { id: "local-2", item: item("local-2", "b") }
  ]);

  assert.equal(out.results.length, 2);
  for (const result of out.results) {
    assert.equal(result.origin.workspace, OTHER);
    assert.match(result.origin.workspace, /\S/);
    assert.ok(result.origin.viaEdge.relation);
    assert.equal(result.origin.crossWorkspace, true);
  }
});

test("an edge in the other direction is followed too", async () => {
  // The query may be on either end of a link.
  const { retriever } = build({
    edges: [edge({ workspace_from: OTHER, item_from: "foreign-1", workspace_to: WORKSPACE, item_to: "local-1" })],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "from the other end") }
  });

  const out = await expand(retriever);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].origin.workspace, OTHER);
});

test("a weak edge is never consulted, not even for a confident query", async () => {
  // The edge's own confidence is a first gate, before the model. A weak link
  // is not "consulted and probably rejected" — it is not read.
  const { retriever, decision } = build({
    edges: [edge({ confidence: 0.2 })],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") }
  });

  const out = await expand(retriever);

  assert.deepEqual(out.results, []);
  assert.equal(decision.calls.length, 0, "and the model was never asked");
  assert.equal(out.edges, 1, "though the edge was found — which is worth distinguishing");
});

test("an edge below the confidence threshold reports why", async () => {
  const { retriever, auditRows } = build({
    edges: [edge({ confidence: 0.2 })],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") }
  });

  const out = await expand(retriever);
  assert.match(out.reason, /weaker than the threshold/);
  assert.equal(out.edges, 1, "and the count of edges that were considered");
  assert.equal(auditRows[0].outcome, "below_threshold");
  assert.equal(auditRows[0].edgesFound, 1, "and the count the store received, in the field name it uses");
});

test("an edge pointing at a missing item yields nothing, not a crash", async () => {
  const { retriever } = build({ edges: [edge()], items: {} });
  const out = await expand(retriever);

  assert.deepEqual(out.results, []);
  assert.match(out.reason, /could be read/);
  assert.equal(out.edges, 1, "and the edges that pointed at nothing are still reported");
});

// ---------------------------------------------------------------------------
// Gate 3: the model decides, per query
// ---------------------------------------------------------------------------

test("a foreign item the model rejects does not cross, even through a strong edge", async () => {
  const { retriever, auditRows } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "Bia is six") },
    noul: 0.3
  });

  const out = await expand(retriever);

  assert.deepEqual(out.results, [], "a perfect edge is not sufficient on its own");
  assert.equal(out.belowThreshold, 1);
  assert.equal(out.admitted, 0);
  assert.equal(auditRows[0].outcome, "ok");
  assert.match(auditRows[0].detail, /none at or above/);
});

test("the same edge admits a different item for a different question", async () => {
  // The edge is a claim that two things are related; the model decides
  // whether that relationship answers *this*. A cross-workspace system that
  // returned everything reachable would be a context leak wearing a graph.
  const items = {
    [`${OTHER}/about-bia`]: item("about-bia", "Bia is six years old"),
    [`${OTHER}/about-ledger`]: item("about-ledger", "the ledger reconciles quarterly")
  };

  const bySubject = build({ edges: [edge({ item_to: "about-bia" })], items, noul: 0.9 });
  const admittedBia = await expand(bySubject.retriever);
  assert.equal(admittedBia.results.length, 1);
  assert.match(admittedBia.results[0].item.content, /Bia/);

  const byRelevance = build({
    edges: [edge({ item_to: "about-bia" })],
    items,
    // Same edge, same item, a question the memory does not answer.
    noul: (state) => (state.includes("Bia is six") ? 0.2 : 0.95)
  });
  const refused = await expand(byRelevance.retriever);
  assert.deepEqual(refused.results, []);
});

test("results are ordered by the model's own score, not by edge order", async () => {
  const { retriever } = build({
    edges: [
      edge({ id: "e1", item_to: "weak-but-above", confidence: 0.76 }),
      edge({ id: "e2", item_from: "local-2", item_to: "strong", confidence: 1 })
    ],
    items: {
      [`${OTHER}/weak-but-above`]: item("weak-but-above", "x"),
      [`${OTHER}/strong`]: item("strong", "y")
    },
    noul: (state) => (state.includes("\ny\n") ? 0.99 : 0.8)
  });

  const out = await expand(retriever, [
    { id: "local-1", item: item("local-1", "a") },
    { id: "local-2", item: item("local-2", "b") }
  ]);

  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].origin.viaEdge.confidence, 1, "the higher relevance comes first");
});

// ---------------------------------------------------------------------------
// Gate 4: fail closed
// ---------------------------------------------------------------------------

test("with the provider down, NOTHING crosses", async () => {
  // The asymmetry. Ordinary retrieval degrades open; this degrades closed.
  const { retriever, auditRows } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "Bia is six years old") },
    fail: true
  });

  const out = await expand(retriever);

  assert.deepEqual(out.results, [], "a perfect edge and a perfect query still yield nothing");
  assert.equal(out.failClosed, true);
  assert.equal(out.admitted, 0);
  assert.equal(out.providerFailed, 1);
  assert.match(out.reason, /failed for every candidate/);
  assert.equal(auditRows[0].outcome, "provider_unavailable");
});

test("with no provider configured, nothing crosses and it says so before looking", async () => {
  const { retriever, decision, auditRows } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") },
    available: false
  });

  const out = await expand(retriever);

  assert.deepEqual(out.results, []);
  assert.equal(out.failClosed, true);
  assert.match(out.reason, /no decision provider is configured/);
  assert.equal(decision.calls.length, 0, "and no lookup is even attempted");
  assert.equal(auditRows[0].outcome, "no_provider");
});

test("an unreadable shared store means nothing crosses, not 'this workspace only'", async () => {
  // The tempting fallback is to answer from local results and call it
  // cross-workspace. That is a search that silently stopped checking, and it
  // is indistinguishable from one that checked and found nothing.
  const localAuditRows = [];
  const retriever = createCrossWorkspaceRetriever({
    // The searching workspace's store must refuse the audit. A record of what
    // crossed, held by whoever crossed it, is not an audit trail.
    store: {
      async recordCrossWorkspaceAudit(row) { localAuditRows.push(row); }
    },
    sharedStore: {
      async recordCrossWorkspaceAudit(row) { audits.push(row); },
      async findCrossWorkspaceEdges() {
        throw new Error("could not connect to server: operation not permitted");
      }
    },
    client: client(),
    threshold: undefined
  });
  retriever.useStores(() => ({ async readItem() { return null; } }));

  const out = await expand(retriever);

  assert.deepEqual(out.results, []);
  assert.equal(out.failClosed, true);
  assert.match(out.reason, /shared edge store/);
  assert.equal(out.edges, null, "and no edge count, because the lookup itself is what failed");
  assert.equal(audits.at(-1).outcome, "error");
  assert.match(audits.at(-1).detail, /operation not permitted/, "with the cause, not a status");
  assert.equal(localAuditRows.length, 0, "and the searching workspace's store was never asked");
});

test("a partial provider failure admits only what was actually judged", async () => {
  const { retriever, auditRows } = build({
    edges: [
      edge({ id: "e1", item_to: "judgeable" }),
      edge({ id: "e2", item_from: "local-2", item_to: "broken" })
    ],
    items: {
      [`${OTHER}/judgeable`]: item("judgeable", "this one is judged"),
      [`${OTHER}/broken`]: item("broken", "this one throws")
    },
    failFor: "this one throws"
  });

  const out = await expand(retriever, [
    { id: "local-1", item: item("local-1", "a") },
    { id: "local-2", item: item("local-2", "b") }
  ]);

  assert.equal(out.results.length, 1, "the one that was judged and passed");
  assert.equal(out.results[0].origin.itemId, "judgeable");
  assert.equal(out.results[0].item.content, "this one is judged");
  assert.equal(out.providerFailed, 1);
  assert.ok(out.admitted <= out.candidates, "and nothing was admitted that was not judged");
  assert.equal(auditRows[0].admitted, 1);
});

test("a malformed answer is treated as not judged, not as approval", async () => {
  // A missing or unusable verdict must not read as a high score. That is the
  // whole class of bug where an absent value becomes a permissive one.
  const retriever = createCrossWorkspaceRetriever({
    store: { async recordCrossWorkspaceAudit() { throw new Error("the audit must not go to the searching workspace"); } },
    sharedStore: {
      async recordCrossWorkspaceAudit() {},
      async findCrossWorkspaceEdges({ fromWorkspace, itemIds }) {
        return itemIds.includes("local-1") ? [edge()] : [];
      }
    },
    client: {
      model: "m",
      available: () => true,
      async decide() {
        return { answers: { relevant_to_query: { type: "choice", choice: "yes" } }, model: "m", cost: 0, latencyMs: 1 };
      }
    }
  });
  retriever.useStores(() => ({ async readItem() { return item("foreign-1", "a"); } }));

  const out = await expand(retriever);
  assert.deepEqual(out.results, []);
  assert.match(out.reason, /failed for every candidate/);
});

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

test("the threshold defaults high and is reported on every result", async () => {
  // Higher than the write gate's, and it may only ever rise. Being too low
  // leaks context across a boundary the user drew; being too high merely
  // misses something they could have found by switching workspace.
  const { retriever } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") },
    noul: 0.76
  });

  const out = await expand(retriever);
  assert.equal(retriever.threshold, 0.75);
  assert.equal(out.results[0].origin.threshold, 0.75);
  assert.equal(out.threshold, 0.75);
});

test("a score just under the threshold does not cross", async () => {
  const { retriever } = build({
    edges: [edge()],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") },
    noul: 0.7499
  });
  assert.deepEqual((await expand(retriever)).results, []);
});

test("an explicit threshold overrides the default", async () => {
  const { retriever } = build({
    edges: [edge({ confidence: 0.5 })],
    items: { [`${OTHER}/foreign-1`]: item("foreign-1", "a") },
    noul: 0.6,
    threshold: 0.5
  });
  const out = await expand(retriever);
  assert.equal(out.threshold, 0.5);
  assert.equal(out.results.length, 1, "an edge at exactly the threshold is consulted");
});

test("an empty local result set does not consult the model", async () => {
  const { retriever, decision } = build({ edges: [edge()], items: {} });
  const out = await expand(retriever, []);

  assert.deepEqual(out.results, []);
  assert.match(out.reason, /nothing/);
  assert.equal(decision.calls.length, 0);
});

test("nothing is embedded in the query, so the audit holds no question text", async () => {
  const { retriever, auditRows } = build({
    edges: [],
    items: {}
  });

  await expand(retriever);

  const serialised = JSON.stringify(auditRows);
  assert.equal(serialised.includes("who is Bia"), false);
  assert.match(auditRows[0].queryHash, /^[0-9a-f]{32}$/);
});
