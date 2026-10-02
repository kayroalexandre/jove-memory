import { test } from "node:test";
import assert from "node:assert/strict";

import { createReranker, RERANK_QUESTION } from "../src/decisions/rerank.mjs";
import { NOUL } from "../src/decisions/client.mjs";

/**
 * Rerank, with no network.
 *
 * Two properties matter and neither is about ranking quality, which needs a
 * benchmark rather than a unit test:
 *
 *   1. It degrades. A beta third party being down must return results in fused
 *      order, flagged — not throw, and not claim to be ranked.
 *   2. It refuses to rank what it cannot read. The first benchmark run scored
 *      45% where fusion scored 106%, which looked like a model ranking
 *      relevance backwards and was a `?.` chain that handed it an empty memory
 *      for every candidate. That produced a confident ordering of nothing.
 */

/** A candidate in the shape a fusion result has. */
const fused = (id, content, score = 0.1) => ({
  id,
  score,
  arms: { vector: { rank: 1 } },
  payload: { id, item: { id, content } }
});

/** A client that scores by whether the query word appears in the candidate. */
function scoringClient({ fail = false, noulFor = null } = {}) {
  return {
    model: "upstage/solar-decide",
    available: () => true,
    async decide({ state }) {
      if (fail) throw new Error("provider unavailable");
      const question = state.split("QUESTION:\n")[1]?.split("\n")[0] ?? "";
      const memory = state.split("CANDIDATE MEMORY:\n")[1] ?? "";
      const term = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3)[0] ?? "";
      const noul = noulFor ? noulFor(state) : memory.toLowerCase().includes(term) ? 0.9 : 0.1;
      return {
        answers: { [RERANK_QUESTION.key]: { type: NOUL, noul, inRange: true } },
        model: "upstage/solar-decide-20260901",
        requestedModel: "upstage/solar-decide",
        cost: 0.00001,
        latencyMs: 1
      };
    }
  };
}

const noStore = { async recordDecision() {} };

// ---------------------------------------------------------------------------
// Refusing to rank what it cannot read
// ---------------------------------------------------------------------------

test("a candidate with no readable content is refused, not ranked blind", async () => {
  const reranker = createReranker({ client: scoringClient() });

  // The shape the reranker is handed by the searcher, with the text one level
  // deeper than a naive read expects.
  const results = [fused("a", "the desk is 118cm"), { id: "b", score: 0.1, arms: {} }];

  await assert.rejects(
    () => reranker.rerank({ query: "how tall is my desk", results }),
    (err) => {
      assert.match(err.message, /no readable content/);
      assert.match(err.message, /ids: b/);
      assert.match(err.message, /ranked blind/);
      return true;
    }
  );
});

test("all three candidate shapes are read", async () => {
  const reranker = createReranker({ client: scoringClient() });
  const results = [
    { id: "mapped", item: { content: "the desk is 118cm tall" } },
    { id: "fused", payload: { item: { content: "the desk is 118cm tall" } } },
    { id: "bare", content: "the desk is 118cm tall" }
  ];

  const outcome = await reranker.rerank({ query: "how tall is the desk", results });

  assert.equal(outcome.ranked, true);
  assert.equal(outcome.results.length, 3);
  for (const result of outcome.results) {
    assert.equal(typeof result.rerank, "number", `${result.id} was judged`);
  }
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test("a provider failure returns results in fused order, flagged unranked", async () => {
  const reranker = createReranker({ client: scoringClient({ fail: true }) });
  const results = [fused("a", "one"), fused("b", "two"), fused("c", "three")];

  const outcome = await reranker.rerank({ query: "anything", results });

  assert.equal(outcome.ranked, false, "claiming 'ranked' with no scores is a lie a caller acts on");
  assert.match(outcome.reason, /failed for all 3 candidates/);
  assert.deepEqual(outcome.results.map((r) => r.id), ["a", "b", "c"], "order preserved");
  assert.equal(outcome.cost, 0);
});

test("no provider at all is a skip, not a failure", async () => {
  const reranker = createReranker({ client: { model: "m", available: () => false } });
  const outcome = await reranker.rerank({ query: "x", results: [fused("a", "one"), fused("b", "two")] });

  assert.equal(outcome.ranked, false);
  assert.match(outcome.reason, /no decision provider configured/);
  assert.equal(outcome.results.length, 2);
});

test("a partial failure reranks what it could and says how much", async () => {
  let calls = 0;
  const reranker = createReranker({
    client: {
      model: "m",
      available: () => true,
      async decide() {
        calls += 1;
        // Fail every third call, so some candidates are judged and some are not.
        if (calls % 3 === 0) throw new Error("timeout");
        return {
          answers: { [RERANK_QUESTION.key]: { type: NOUL, noul: calls % 2 ? 0.2 : 0.8, inRange: true } },
          model: "m-2026",
          cost: 0.00001,
          latencyMs: 1
        };
      }
    }
  });

  const outcome = await reranker.rerank({
    query: "anything",
    results: [fused("a", "1"), fused("b", "2"), fused("c", "3"), fused("d", "4"), fused("e", "5"), fused("f", "6")]
  });

  assert.equal(outcome.ranked, true, "a partial result is still a result");
  assert.ok(outcome.unranked > 0);
  assert.match(outcome.reason, /kept their fused order/);
  // Whatever was judged should be at the top.
  assert.ok(outcome.results[0].rerank !== null);
});

test("an unusable answer leaves that candidate unranked rather than scored zero", async () => {
  // A score of zero would look like a confident "this is irrelevant" and push
  // the memory out of reach. `null` says "not judged".
  const reranker = createReranker({
    client: {
      model: "m",
      available: () => true,
      async decide({ state }) {
        const bad = state.includes("CANDIDATE MEMORY:\nnonsense");
        return {
          answers: {
            [RERANK_QUESTION.key]: bad
              ? { type: "choice", choice: "x" }
              : { type: NOUL, noul: 0.9, inRange: true }
          },
          model: "m",
          cost: 0,
          latencyMs: 1
        };
      }
    }
  });

  const outcome = await reranker.rerank({
    query: "anything",
    results: [fused("good", "something real"), fused("nonsense", "nonsense")]
  });

  const bad = outcome.results.find((r) => r.id === "nonsense");
  assert.equal(bad.rerank, null, "not scored zero");
  assert.match(bad.rerankReason, /no usable answer/);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("a higher noul comes first, and the fused score is the tiebreak", async () => {
  const reranker = createReranker({ client: scoringClient() });
  const results = [
    fused("low", "no match here", 0.5),
    fused("high", "desk desk desk desk", 0.1)
  ];

  const outcome = await reranker.rerank({ query: "desk", results });

  // Fused order would have put `low` first. Rerank must override a fused score
  // it disagrees with — that is the entire reason for the stage.
  assert.equal(outcome.results[0].id, "high");
});

test("equal scores keep the fused order, so the result is deterministic", async () => {
  const flat = {
    model: "m",
    available: () => true,
    async decide() {
      return { answers: { [RERANK_QUESTION.key]: { type: NOUL, noul: 0.5, inRange: true } }, model: "m", cost: 0, latencyMs: 1 };
    }
  };
  const reranker = createReranker({ client: flat });
  const results = [fused("a", "1", 0.3), fused("b", "2", 0.2), fused("c", "3", 0.1)];

  const outcome = await reranker.rerank({ query: "x", results });
  assert.deepEqual(outcome.results.map((r) => r.id), ["a", "b", "c"]);
});

test("candidates past topK keep their order at the tail", async () => {
  const reranker = createReranker({ client: scoringClient() });
  const results = Array.from({ length: 8 }, (_, i) => fused(`m${i}`, `memory ${i}`, 0.2 - i * 0.01));

  const outcome = await reranker.rerank({ query: "memory", results, topK: 3 });

  assert.equal(outcome.results.length, 8, "nothing is dropped — rerank reorders, it does not truncate");
  assert.equal(outcome.results.filter((r) => typeof r.rerank === "number").length, 3);
  const tail = outcome.results.slice(3).map((r) => r.id);
  assert.deepEqual(tail, ["m3", "m4", "m5", "m6", "m7"]);
});

test("zero or one candidate is not a rerank", async () => {
  const reranker = createReranker({ client: scoringClient() });

  assert.match((await reranker.rerank({ query: "x", results: [] })).reason, /nothing to rerank/);
  assert.match((await reranker.rerank({ query: "x", results: [fused("a", "1")] })).reason, /one candidate/);
});

test("every judged candidate is recorded, not only the ones that moved", async () => {
  // A log of only the ones that changed cannot be used to measure whether
  // rerank helped, which is the only question Phase 6 has.
  const recorded = [];
  const reranker = createReranker({
    client: scoringClient(),
    store: { async recordDecision(record) { recorded.push(record); } }
  });

  await reranker.rerank({
    query: "desk",
    results: [fused("a", "no match"), fused("b", "desk desk desk desk"), fused("c", "still no match")]
  });

  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].operation, "rerank");
  assert.equal(recorded[0].questionKey, RERANK_QUESTION.key);
  // A hash, never the query. `decisions` is the calibration substrate, it grows
  // without bound, and a copy of every query ever asked would be the largest
  // unencrypted copy of the user's memory in the system.
  assert.match(recorded[0].contextHash, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(recorded).includes("desk desk"), false, "no query text in the log");
});

test("a failed decision record does not fail the rerank", async () => {
  const reranker = createReranker({
    client: scoringClient(),
    store: { async recordDecision() { throw new Error("decisions table is gone"); } }
  });

  const outcome = await reranker.rerank({ query: "desk", results: [fused("a", "desk desk desk"), fused("b", "x y z")] });
  assert.equal(outcome.ranked, true);
});

test("the question is typed, and long candidates are truncated", async () => {
  const seen = [];
  const reranker = createReranker({
    client: {
      model: "m",
      available: () => true,
      async decide(input) {
        seen.push(input);
        return { answers: { [RERANK_QUESTION.key]: { type: NOUL, noul: 0.5, inRange: true } }, model: "m", cost: 0, latencyMs: 1 };
      }
    }
  });

  await reranker.rerank({ query: "q", results: [fused("a", "x".repeat(5000)), fused("b", "short")] });

  assert.equal(seen[0].questions[RERANK_QUESTION.key].type, NOUL);
  assert.ok(seen[0].state.includes("CANDIDATE MEMORY:\nxxx"), "and truncated with a marker");
  assert.ok(seen[0].state.includes("…"));
  assert.equal(seen[0].state.includes("x".repeat(1201)), false, "not the whole 5000 characters");
});
