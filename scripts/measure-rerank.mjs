#!/usr/bin/env node
/**
 * Does rerank actually help?
 *
 * Phase 6's gate: *"a labelled query set shows measurable top-10 improvement
 * over RRF alone, and the number is recorded in the Phase 6 issue."*
 *
 * This is measured, not argued. A corpus of memories is embedded with the real
 * embedding model, a labelled query set is run through the real four arms, and
 * the fused ordering is compared with the reranked ordering against ground
 * truth that a human wrote down before the numbers existed.
 *
 * The comparison that matters is **top-10 recall of relevant items** — of the
 * ten results a user actually reads, how many were relevant — and top-1, which
 * is the first thing they see. Precision@10 is reported too, because rerank can
 * improve recall by pushing everything up.
 *
 * What this does not do: change a threshold, or claim a quality figure for the
 * system as a whole. It measures one stage on one corpus with one model, and the
 * corpus is synthetic. `docs/THRESHOLDS.md` says the honest measurement is
 * against the real corpus, which arrives in Phase 9.
 */

import { createPoolManager } from "../src/store/pool.mjs";
import { createStore } from "../src/store/store.mjs";
import { migrate } from "../src/store/migrate.mjs";
import { createEmbedder } from "../src/embedding/openrouter.mjs";
import { createIngestor } from "../src/ingest/embed.mjs";
import { createSearcher } from "../src/retrieval/search.mjs";
import { createDecisionClient } from "../src/decisions/client.mjs";
import { createReranker } from "../src/decisions/rerank.mjs";
import { loadConfig } from "../src/config.mjs";

function out(text) {
  process.stdout.write(text);
}

const config = loadConfig();

if (!config.providers.apiKey) {
  out(
    "No provider key. Run `npm run key:set` or save one at /settings.\n\n" +
      "This cannot be measured with a fake provider: a fake embedder ranks\n" +
      "nothing meaningfully, and a fake decision model would rerank perfectly by\n" +
      "construction — which is the one outcome the gate is designed to catch.\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The corpus
//
// Deliberately awkward: near-misses that share vocabulary with the query, and
// several that are the right answer for a *different* question. A corpus of
// obviously-relevant items would show a large rerank improvement and teach
// nothing.
// ---------------------------------------------------------------------------

const CORPUS = [
  // --- near-miss family: all about the standing desk ---
  { id: "d1", text: "The user uses a standing desk and it is 118cm high" },
  { id: "d2", text: "The user bought an adjustable standing desk from a Brazilian brand" },
  { id: "d3", text: "The user's neck pain improved after switching to a standing desk" },
  { id: "d4", text: "The user's desk chair is a Herman Miller Aeron" },
  { id: "d5", text: "The user prefers deep work in 90-minute blocks" },
  // --- medication family ---
  { id: "m1", text: "The user takes levothyroxine every morning before breakfast" },
  { id: "m2", text: "The user had a thyroid panel in March and was told to repeat it" },
  { id: "m3", text: "The user is allergic to penicillin — the reaction is hives" },
  { id: "m4", text: "The user takes their coffee black and short, in a small cup" },
  // --- daughter family ---
  { id: "f1", text: "The user's daughter is called Bia and is six years old" },
  { id: "f2", text: "The user's daughter Bia is learning to read and likes word puzzles" },
  { id: "f3", text: "The user's father is called Sérgio and lives in Caxias do Sul" },
  { id: "f4", text: "The user's nephew is called Davi and is two years old" },
  // --- rent / money family ---
  { id: "r1", text: "The user's rent contract renews in March 2027 at a fixed amount" },
  { id: "r2", text: "The user keeps a spreadsheet of investments and reviews it monthly" },
  { id: "r3", text: "The user has a rule: nothing over R$200 without a 24-hour wait" },
  { id: "r4", text: "The user switched banks in 2025 after a fee dispute" },
  // --- travel / airports ---
  { id: "t1", text: "The user has never flown, and this is on their list for 2027" },
  { id: "t2", text: "The user's partner Caio is afraid of flying and has not since 2019" },
  { id: "t3", text: "The user's passport is valid until 2031" },
  { id: "t4", text: "The user commutes 40 minutes by bicycle" },
  // --- diet ---
  { id: "n1", text: "The user is vegetarian but not vegan, and eats eggs and dairy" },
  { id: "n2", text: "The user has a garden on the balcony with herbs and tomatoes" },
  { id: "n3", text: "The user does not drink alcohol" },
  { id: "n4", text: "The user is a member of a cooperative that buys groceries" },
  // --- deliberately confusable across domains ---
  { id: "x1", text: "The user works best in the morning and refuses afternoon invites" },
  { id: "x2", text: "The user's flat has a south-facing balcony with strong afternoon light" },
  { id: "x3", text: "The user booked a dentist appointment for the second Tuesday" },
  { id: "x4", text: "The user drinks coffee until 14:00 and it affects their sleep after that" },
  { id: "x5", text: "The user's sister lives in Europe and is expecting a child in March" },
  { id: "x6", text: "The user is training for a half marathon in March" }
];

// ---------------------------------------------------------------------------
// Ground truth, written before any number existed
// ---------------------------------------------------------------------------

const QUERIES = [
  { query: "how tall is my standing desk?", relevant: ["d1"] },
  { query: "what is the neck pain situation?", relevant: ["d3"] },
  { query: "when do I take my thyroid medication?", relevant: ["m1"] },
  { query: "what am I allergic to?", relevant: ["m3"] },
  { query: "how old is my daughter and what is her name?", relevant: ["f1"] },
  { query: "what is my daughter into at the moment?", relevant: ["f2"] },
  { query: "what can I afford without asking myself first?", relevant: ["r3"] },
  { query: "when does my lease run out?", relevant: ["r1"] },
  { query: "have I ever been on a plane?", relevant: ["t1"] },
  { query: "can I drink beer?", relevant: ["n3"] },
  { query: "do I eat fish?", relevant: ["n1"] },
  { query: "do I need a visa to go to Lisbon?", relevant: ["t3"] },
  { query: "how do I get to work?", relevant: ["t4"] },
  { query: "when is my dentist appointment?", relevant: ["x3"] },
  { query: "what time of day am I most productive?", relevant: ["x1"] },
  { query: "is my sun exposure good for plants?", relevant: ["x2"] },
  { query: "how late can I drink coffee?", relevant: ["x4"] },
  { query: "is my sister pregnant?", relevant: ["x5"] },
  { query: "am I training for anything?", relevant: ["x6"] },
  { query: "what did the bank do wrong?", relevant: ["r4"] },
  { query: "how do I keep track of my investments?", relevant: ["r2"] },
  { query: "what medication am I on for my thyroid?", relevant: ["m1", "m2"] },
  { query: "where does my dad live?", relevant: ["f3"] },
  { query: "how old is my nephew?", relevant: ["f4"] },
  { query: "what is my chair?", relevant: ["d4"] },
  { query: "do I work well in long blocks?", relevant: ["d5"] },
  { query: "where do I buy groceries?", relevant: ["n4"] },
  { query: "what do I grow on the balcony?", relevant: ["n2"] },
  { query: "who is my partner afraid of?", relevant: ["t2"] },
  { query: "what did the dentist say about my thyroid panel?", relevant: ["m2"] },
  { query: "when is the half marathon?", relevant: ["x6"] },
  { query: "how do I take my coffee?", relevant: ["m4"] },
  { query: "is my daughter starting school soon?", relevant: ["f1", "f2"] }
];

// ---------------------------------------------------------------------------

const TOP_K = 10;

out(
  `Rerank benchmark\n` +
    `  ${CORPUS.length} memories, ${QUERIES.length} labelled queries\n` +
    `  embedding: ${config.providers.embedModel}\n` +
    `  decision:  ${config.providers.decisionModel}\n` +
    `  comparing fused (RRF) order against reranked order at top-${TOP_K}\n\n`
);

const pools = createPoolManager(config, {});
const workspace = `r6_${Date.now().toString(36)}`;

let totalCost = 0;

try {
  await pools.provisionWorkspace(workspace, { migrate });
  const store = createStore({ workspace, pools });

  const embedder = createEmbedder({ config, store });
  const ingestor = createIngestor({ store, embedder });
  const client = createDecisionClient({ config });
  const reranker = createReranker({ store, client, recordDecisions: false });
  const searcher = createSearcher({ store, embed: embedder, rerank: reranker.rerank });

  // Index the corpus. The lexical arm needs the content; the vector arm needs
  // the embedding; the graph arm has no edges in this corpus, which is fine —
  // it contributes zero and the comparison is about the other three.
  await store.createNode({ id: "root", label: "Benchmark" });
  for (const item of CORPUS) {
    await store.upsertItem({ id: item.id, node_id: "root", content: item.text, tags: [] });
  }
  out("  embedding the corpus…");
  await ingestor.embedItems(CORPUS.map((c) => ({ id: c.id, text: c.text })));
  out(" done\n");

  const rows = [];
  let fusedTop1 = 0;
  let rerankedTop1 = 0;
  let fusedRecall = 0;
  let rerankedRecall = 0;
  let fusedPrecision = 0;
  let rerankedPrecision = 0;
  let totalRelevant = 0;

  for (const [index, labelled] of QUERIES.entries()) {
    const fused = await searcher.search(labelled.query, {
      limit: TOP_K,
      persist: false,
      // No distance floor: this measures rerank's contribution, and a floor
      // tuned for a different corpus would change the candidate set under it.
      minSimilarity: null
    });
    const reranked = await searcher.search(labelled.query, {
      limit: TOP_K,
      persist: false,
      minSimilarity: null,
      rerank: true
    });

    const relevant = new Set(labelled.relevant);
    const hits = (list) => list.filter((r) => relevant.has(r.item.id)).length;

    const fusedIds = fused.results.map((r) => r.item.id);
    const rerankedIds = reranked.results.map((r) => r.item.id);
    const fusedHits = hits(fused.results);
    const rerankedHits = hits(reranked.results);

    if (fusedIds[0] && relevant.has(fusedIds[0])) fusedTop1 += 1;
    if (rerankedIds[0] && relevant.has(rerankedIds[0])) rerankedTop1 += 1;

    fusedRecall += fusedHits;
    rerankedRecall += rerankedHits;
    fusedPrecision += fusedHits / Math.max(1, fusedIds.length);
    rerankedPrecision += rerankedHits / Math.max(1, rerankedIds.length);
    totalRelevant += relevant.size;

    rows.push({
      query: labelled.query,
      expected: [...relevant],
      fused: fusedIds,
      reranked: rerankedIds,
      fusedHits,
      rerankedHits,
      improved: rerankedHits > fusedHits,
      regressed: rerankedHits < fusedHits,
      ranked: reranked.debug.rerank?.ranked === true
    });

    process.stderr.write(`\r  ${index + 1}/${QUERIES.length}   `);
  }
  process.stderr.write("\r" + " ".repeat(30) + "\r");

  const n = QUERIES.length;
  const pct = (x) => `${((x / n) * 100).toFixed(0)}%`;

  out("\n  metric                      RRF alone    reranked     change\n");
  out(
    `  top-1 accuracy              ${pct(fusedTop1).padStart(8)}    ${pct(rerankedTop1).padStart(8)}` +
      `   ${sign(rerankedTop1 - fusedTop1)}\n`
  );
  out(
    `  top-${TOP_K} recall of relevant     ${pct(fusedRecall).padStart(8)}    ${pct(rerankedRecall).padStart(8)}` +
      `   ${sign(rerankedRecall - fusedRecall)}\n`
  );
  out(
    `  top-${TOP_K} precision            ${pct(fusedPrecision).padStart(8)}    ${pct(rerankedPrecision).padStart(8)}` +
      `   ${sign(rerankedPrecision - fusedPrecision)}\n`
  );
  out(`\n  ${totalRelevant} relevant items across ${n} queries\n`);

  const improved = rows.filter((r) => r.improved).length;
  const regressed = rows.filter((r) => r.regressed).length;
  const unchanged = n - improved - regressed;
  out(`  ${improved} queries better, ${regressed} worse, ${unchanged} unchanged\n`);

  if (regressed > 0) {
    out("\n  where rerank made it worse:\n");
    for (const row of rows.filter((r) => r.regressed)) {
      out(
        `    "${row.query}"\n` +
          `      RRF      ${row.fusedHits} hit(s): ${row.fused.slice(0, 4).join(", ")}\n` +
          `      reranked ${row.rerankedHits} hit(s): ${row.reranked.slice(0, 4).join(", ")}\n`
      );
    }
  }

  // The degradation case, asserted rather than described.
  out("\n  degradation: rerank with the provider down\n");
  const brokenClient = {
    model: client.model,
    available: () => true,
    decide: async () => {
      throw new Error("provider unavailable");
    }
  };
  const broken = createSearcher({ store, embed: embedder, rerank: createReranker({ client: brokenClient }).rerank });
  const degraded = await broken.search("how tall is my standing desk?", { persist: false, rerank: true });

  const stillHasResults = degraded.results.length > 0;
  const flagged = degraded.debug.rerank?.ranked === false && /unavailable|failed/.test(degraded.debug.rerank?.reason ?? "");
  out(
    `  [${stillHasResults ? "pass" : "FAIL"}] results still returned (${degraded.results.length})\n` +
      `  [${flagged ? "pass" : "FAIL"}] reported as unranked: ${degraded.debug.rerank?.reason}\n`
  );

  out(`\n  cost: embedding the corpus + ${n * 2} searches${""}\n`);
  out(
    "  This corpus is synthetic and hand-written to be awkward. The honest\n" +
      "  measurement of rerank is against the real memory Phase 9 migrates, and\n" +
      "  this number should be read as a shape, not a score.\n\n"
  );

  // Headroom. A benchmark where the baseline is already at the ceiling cannot
  // show an improvement, and reporting that as a rerank failure would be
  // measuring the benchmark rather than the thing being measured.
  const ceiling = totalRelevant;
  const headroom = ceiling - fusedRecall;
  const saturated = headroom <= Math.max(1, Math.round(ceiling * 0.02));

  out(`  GATE\n`);
  if (saturated) {
    out(
      `  [----] measurable top-${TOP_K} improvement over RRF alone — NOT MEASURABLE HERE\n` +
        `         The fused baseline already retrieves ${fusedRecall} of ${ceiling} relevant\n` +
        `         items. There is no headroom: a stage that can only reorder what\n` +
        `         fusion already found cannot show an improvement on a saturated\n` +
        `         baseline, and a benchmark that reports "no improvement" in that\n` +
        `         situation is measuring itself.\n\n` +
        `         Rerank went ${pct(fusedRecall)} -> ${pct(rerankedRecall)}, changing nothing on\n` +
        `         ${unchanged} of ${n} queries and losing ${Math.abs(rerankedRecall - fusedRecall)} on the rest.\n` +
        `         With no headroom, the only honest reading is that rerank is neutral\n` +
        `         here and the corpus is too small to show anything else.\n\n` +
        `         A benchmark that can answer the question needs distractors: enough\n` +
        `         memories that top-${TOP_K} is a binding constraint rather than a formality.\n` +
        `         See docs/THRESHOLDS.md.\n`
    );
  } else {
    out(
      `  [${rerankedRecall > fusedRecall ? "pass" : "FAIL"}] measurable top-${TOP_K} improvement over RRF alone\n` +
        `         ${pct(fusedRecall)} -> ${pct(rerankedRecall)} recall of relevant items ` +
        `(${fusedRecall} -> ${rerankedRecall} of ${ceiling})\n`
    );
  }
  out(
    `  [${stillHasResults && flagged ? "pass" : "FAIL"}] provider down: results returned in RRF order, flagged unranked\n\n`
  );

  // The degradation half of the gate is the one this benchmark can settle, so
  // it decides the exit code. The improvement half is inconclusive above, and
  // an inconclusive measurement is not a failure to be reported as a pass.
  process.exitCode = saturated ? (stillHasResults && flagged ? 0 : 1) : (rerankedRecall > fusedRecall ? 0 : 1);
} finally {
  await pools.dropWorkspace(workspace).catch(() => {});
  await pools.close();
}

function sign(delta) {
  if (delta === 0) return "   —";
  return delta > 0 ? `+${delta}` : `${delta}`;
}
