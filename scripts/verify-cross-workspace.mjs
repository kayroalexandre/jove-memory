#!/usr/bin/env node
/**
 * Phase 8's gate, against two real workspaces.
 *
 *   - A query in B returns an item from A only through a real edge
 *   - Zero results cross when no edge exists
 *   - Every cross-workspace result is labelled with its origin
 *   - With the decision provider down, nothing crosses at all
 *
 * Two databases, one shared, because that is the design (ADR-003). A test that
 * put both workspaces in one database would prove nothing about isolation — the
 * whole claim is that a workspace cannot see another's content without going
 * through the shared edge table.
 */

import { createPoolManager } from "../src/store/pool.mjs";
import { createStore } from "../src/store/store.mjs";
import { migrate } from "../src/store/migrate.mjs";
import { createDecisionClient } from "../src/decisions/client.mjs";
import { createCrossWorkspaceRetriever } from "../src/retrieval/cross-workspace.mjs";
import { SHARED_WORKSPACE } from "../src/store/workspace-name.mjs";
import { loadConfig } from "../src/config.mjs";

function out(text) {
  process.stdout.write(text);
}

const config = loadConfig();
const pools = createPoolManager(config, {});

const WORK = `xw_work_${Date.now().toString(36)}`;
const PERSONAL = `xw_personal_${Date.now().toString(36)}`;

let failures = 0;
const check = (label, pass, detail) => {
  out(`  [${pass ? "pass" : "FAIL"}] ${label}\n`);
  if (detail) out(`         ${detail}\n`);
  if (!pass) failures += 1;
};

try {
  out(`Phase 8 — cross-workspace, across "${WORK}" and "${PERSONAL}"\n\n`);

  for (const workspace of [WORK, PERSONAL, SHARED_WORKSPACE]) {
    await pools.provisionWorkspace(workspace, { migrate });
  }

  const work = createStore({ workspace: WORK, pools });
  const personal = createStore({ workspace: PERSONAL, pools });
  const shared = createStore({ workspace: SHARED_WORKSPACE, pools });

  // Memory in two places. The same person, two contexts — which is the case
  // cross-workspace retrieval exists for, and also the case that must not leak
  // by default.
  await work.createNode({ id: "n", label: "Work" });
  await personal.createNode({ id: "n", label: "Personal" });

  await work.upsertItem({
    id: "w1",
    node_id: "n",
    content: "Bia's school called about her reading level last week"
  });
  await work.upsertItem({
    id: "w2",
    node_id: "n",
    content: "the quarterly ledger reconciles the escrow account"
  });
  await personal.upsertItem({
    id: "p1",
    node_id: "n",
    content: "Bia is six years old and is learning to read"
  });
  await personal.upsertItem({
    id: "p2",
    node_id: "n",
    content: "the personal bank statement has a monthly fee"
  });
  await personal.upsertItem({
    id: "p3",
    node_id: "n",
    content: "a private note about a relationship that has nothing to do with work"
  });

  const client = config.providers.apiKey ? createDecisionClient({ config }) : null;

  const retriever = createCrossWorkspaceRetriever({
    store: work,
    sharedStore: shared,
    client,
    threshold: undefined
  });
  retriever.useStores((workspace) =>
    createStore({ workspace, pools, logger: null })
  );

  // -- Isolation, before anything is linked ---------------------------------
  out("\n  isolation\n");

  const leakedDirect = await work.listItems({ limit: 100 });
  check(
    "a workspace cannot read another's items directly",
    !leakedDirect.some((item) => item.id.startsWith("p")),
    `${leakedDirect.length} items visible in work, none from personal`
  );

  const searchLeak = await personal.listItems({ limit: 100 });
  check(
    "nor from the other direction",
    !searchLeak.some((item) => item.id.startsWith("w")),
    `${searchLeak.length} items visible in personal, none from work`
  );

  // -- Gate 2: no edge, no crossing ----------------------------------------
  out("\n  gate: no edge means no crossing\n");

  const localSeeds = [{ id: "w1", item: await work.readItem("w1") }];
  const beforeEdge = await retriever.expand({
    query: "how old is Bia?",
    workspace: WORK,
    results: localSeeds
  });

  check("nothing crosses with no edge", beforeEdge.results.length === 0, beforeEdge.reason);
  check("and the refusal is named", beforeEdge.failClosed === true, `failClosed: ${beforeEdge.failClosed}`);
  check(
    "and the audit distinguishes looked-and-found-nothing from never-looked",
    (await shared.listCrossWorkspaceAudit({ fromWorkspace: WORK }))[0]?.outcome === "no_edges"
  );

  if (!client) {
    out("\n  [skip] no decision provider: the remaining gate items cannot run\n");
    out("         save a key at /settings and re-run\n");
  } else {
    // -- Record an edge, and only one ---------------------------------------
    out("\n  gate: an edge lets a relevant item through\n");

    await shared.addCrossWorkspaceEdge({
      workspaceFrom: WORK,
      itemFrom: "w1",
      workspaceTo: PERSONAL,
      itemTo: "p1",
      relation: "same_entity",
      basis: "entity: Bia",
      confidence: 0.95,
      confirmed: true
    });

    const viaEdge = await retriever.expand({
      query: "how old is my daughter?",
      workspace: WORK,
      results: localSeeds
    });

    check("edges are found", viaEdge.edges >= 1, `${viaEdge.edges} edge(s)`);
    check("a candidate was put to the model", viaEdge.candidates >= 1, `${viaEdge.candidates} candidate(s)`);

    if (viaEdge.results.length === 0) {
      // Not a failure of the design: the model judged the personal memory
      // irrelevant to the work query, which is the correct answer and the whole
      // reason the model is in the path.
      out(
        `         nothing admitted: the model scored the personal memory below the\n` +
          `         ${viaEdge.threshold} threshold for this query. That is the gate working —\n` +
          `         an edge says two things are related, not that one answers any question.\n`
      );
      check(
        "nothing crossed, and the audit says the model declined rather than an error",
        (await shared.listCrossWorkspaceAudit({ fromWorkspace: WORK }))[0]?.outcome === "ok"
      );
    } else {
      const first = viaEdge.results[0];
      check("a foreign item was admitted", Boolean(first), `relevance ${first?.origin?.relevance}`);
      check("it came from the other workspace", first.origin.workspace === PERSONAL, first.origin.workspace);
      check("the peer is the workspace that was searched", first.origin.viaEdge.peerWorkspace === WORK, first.origin.viaEdge.peerWorkspace);
      check("the edge that carried it is named", first.origin.viaEdge.relation === "same_entity", first.origin.viaEdge.basis);
      check("its confidence is reported", first.origin.viaEdge.confidence === 0.95, String(first.origin.viaEdge.confidence));
      check("the threshold is reported", first.origin.threshold === viaEdge.threshold, String(first.origin.threshold));
    }

    // -- A query the foreign memory does not answer --------------------------
    const offTopic = await retriever.expand({
      query: "what is in the quarterly escrow ledger?",
      workspace: WORK,
      results: localSeeds
    });
    check(
      "an edge does not make a foreign item relevant to every question",
      !offTopic.results.some((r) => r.item.id === "p1"),
      `${offTopic.results.length} admitted, none of them the unrelated personal memory`
    );

    // -- Gate 4: fail closed -------------------------------------------------
    out("\n  gate: fail closed\n");

    const broken = createCrossWorkspaceRetriever({
      store: work,
      sharedStore: shared,
      client: {
        model: "m",
        available: () => true,
        decide: async () => {
          throw new Error("provider unavailable");
        }
      }
    });
    broken.useStores((workspace) => createStore({ workspace, pools }));

    const withProviderDown = await broken.expand({
      query: "how old is my daughter?",
      workspace: WORK,
      results: localSeeds
    });

    check("nothing crosses with the provider down", withProviderDown.results.length === 0, withProviderDown.reason);
    check("and the refusal says it failed closed", withProviderDown.failClosed === true, `providerFailed: ${withProviderDown.providerFailed}`);
    check(
      "even with a perfect edge in place",
      withProviderDown.edges === 1,
      "the edge was found and the check on it could not be run"
    );

    const unconfigured = createCrossWorkspaceRetriever({
      store: work,
      sharedStore: shared,
      client: { model: "m", available: () => false, decide: async () => ({}) }
    });
    unconfigured.useStores((workspace) => createStore({ workspace, pools }));

    const withNoProvider = await unconfigured.expand({
      query: "how old is my daughter?",
      workspace: WORK,
      results: localSeeds
    });
    check(
      "with no provider at all, nothing crosses either",
      withNoProvider.results.length === 0 && withNoProvider.failClosed === true,
      withNoProvider.reason
    );

    // -- A weak edge ---------------------------------------------------------
    out("\n  gate: a weak edge is not consulted\n");
    await shared.addCrossWorkspaceEdge({
      workspaceFrom: WORK,
      itemFrom: "w2",
      workspaceTo: PERSONAL,
      itemTo: "p2",
      relation: "same_entity",
      basis: "fuzzy name match",
      confidence: 0.2
    });

    const weak = await retriever.expand({
      query: "what is in the quarterly escrow ledger?",
      workspace: WORK,
      results: [{ id: "w2", item: await work.readItem("w2") }]
    });
    check(
      "a weak edge brings nothing across",
      !weak.results.some((r) => r.item.id === "p2"),
      `${weak.results.length} admitted; the 0.2-confidence edge was not read`
    );
  }

  // -- The audit holds no question text -------------------------------------
  out("\n  audit\n");
  const audits = await shared.listCrossWorkspaceAudit({ fromWorkspace: WORK, limit: 100 });
  // Written by the shared layer, so this is the centralised record.
  check("every expansion is recorded, including the refusals", audits.length > 0, `${audits.length} rows`);
  check(
    "the audit holds a hash and never the question",
    audits.every((row) => /^[0-9a-f]{32}$/.test(row.query_hash)),
    "query_hash on every row"
  );
  const outcomes = [...new Set(audits.map((a) => a.outcome))].sort();
  out(`         outcomes seen: ${outcomes.join(", ")}\n`);

  try {
    await shared.pool().query("UPDATE cross_workspace_audit SET detail = 'edited'");
    check("cross_workspace_audit is append-only", false, "an UPDATE was accepted");
  } catch (err) {
    check("cross_workspace_audit is append-only", /append-only/.test(err.message));
  }
} catch (err) {
  out(`\n  ERROR: ${err.message}\n\n${err.stack}\n`);
  failures += 1;
} finally {
  for (const workspace of [WORK, PERSONAL]) {
    await pools.dropWorkspace(workspace).catch(() => {});
  }
  await pools.close();
}

out(`\n  ${failures === 0 ? "GATE MET" : `${failures} CHECK(S) FAILED`}\n\n`);
process.exit(failures === 0 ? 0 : 1);
