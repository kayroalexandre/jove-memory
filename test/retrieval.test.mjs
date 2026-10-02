import { test } from "node:test";
import assert from "node:assert/strict";

import { fuse, describeArms, RRF_K, DEFAULT_WEIGHTS } from "../src/retrieval/rrf.mjs";
import {
  isValidAt,
  recency,
  rankTemporally,
  filterValidAt
} from "../src/retrieval/temporal.mjs";

/**
 * The fusion and temporal layers, tested without a database.
 *
 * These are the two pieces where a subtle mistake produces plausible-looking
 * results rather than an error: an RRF that works but weights wrongly, or a
 * temporal filter that drops something it should have kept. Both are
 * invisible from the outside, so they are pinned here.
 */

// ---------------------------------------------------------------------------
// RRF
// ---------------------------------------------------------------------------

const ids = (results) => results.map((r) => r.id);

test("an item ranked by more than one arm scores above one ranked by a single arm", () => {
  // 'both' is third in each list; 'solo' is first in one and absent from the
  // other. RRF should prefer the corroborated item — that is the entire
  // argument for fusing ranks instead of picking a winning arm.
  const { results } = fuse({
    arms: {
      vector: [{ id: "solo" }, { id: "other" }, { id: "both" }],
      bm25: [{ id: "other2" }, { id: "solo2" }, { id: "both" }],
      graph: [],
      temporal: []
    }
  });

  const both = results.find((r) => r.id === "both");
  const solo = results.find((r) => r.id === "solo");

  assert.ok(both.score > solo.score, "corroboration must outrank a single first place");
  assert.deepEqual(Object.keys(both.arms).sort(), ["bm25", "vector"]);
  assert.equal(both.arms.vector.rank, 3);
  assert.equal(both.arms.bm25.rank, 3);
});

test("k is the paper's 60 and is not a per-deployment knob", () => {
  assert.equal(RRF_K, 60);
  const { k } = fuse({ arms: { vector: [] } });
  assert.equal(k, 60);
});

test("a large k flattens the curve, so the top result cannot dominate", () => {
  const build = (k) =>
    fuse({
      arms: {
        vector: [{ id: "first" }, { id: "second" }],
        bm25: [],
        graph: [],
        temporal: []
      },
      k
    }).results;

  const [first, second] = build(60);
  // At k=60, rank 1 scores 1/61 and rank 2 scores 1/62 — nearly equal. That
  // flatness is the property that makes fusion robust when an arm's top hit
  // is a bad one.
  const ratio = first.score / second.score;
  assert.ok(ratio < 1.05, `expected a flat curve, got a ratio of ${ratio}`);
});

test("the first arm to surface an item owns the returned payload", () => {
  const { results } = fuse({
    arms: {
      vector: [{ id: "x", item: { content: "from vector" } }],
      bm25: [{ id: "x", item: { content: "from bm25" } }],
      graph: [],
      temporal: []
    }
  });

  assert.equal(results[0].payload.item.content, "from vector");
});

test("a weight of zero disables an arm without hiding it", () => {
  const { results } = fuse({
    arms: {
      vector: [{ id: "keep" }],
      bm25: [{ id: "drop" }],
      graph: [],
      temporal: []
    },
    weights: { ...DEFAULT_WEIGHTS, bm25: 0 }
  });

  assert.equal(ids(results)[0], "keep");
  const dropped = results.find((r) => r.id === "drop");
  assert.ok(dropped, "the zeroed arm's result is still reported");
  assert.equal(dropped.score, 0);
  assert.equal(dropped.arms.bm25.zeroed, true);
  assert.equal(dropped.arms.bm25.contribution, 0);
});

test("an empty arm contributes nothing and does not break fusion", () => {
  const { results } = fuse({
    arms: { vector: [{ id: "a" }], bm25: [], graph: [], temporal: [] }
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].score, (1.0) / (RRF_K + 1));
});

test("a missing arm is treated as empty, not as an error", () => {
  const { results } = fuse({ arms: { vector: [{ id: "a" }] } });
  assert.equal(results.length, 1);
});

test("a non-array arm is ignored rather than throwing", () => {
  const { results } = fuse({ arms: { vector: [{ id: "a" }], bm25: null, graph: undefined } });
  assert.deepEqual(ids(results), ["a"]);
});

test("a genuine tie breaks on id, not on which arm found the item first", () => {
  // Two items, each ranked first by exactly one arm, so the scores are
  // identical. Without the tiebreak the order follows Map insertion, which
  // follows arm order — and looks stable until one arm returns a different
  // set. The determinism gate depends on this line.
  const forward = fuse({
    arms: { vector: [{ id: "a" }], bm25: [{ id: "b" }], graph: [], temporal: [] }
  });
  const reversed = fuse({
    arms: { bm25: [{ id: "b" }], vector: [{ id: "a" }], graph: [], temporal: [] }
  });

  assert.equal(forward.results[0].score, forward.results[1].score, "the fixture must really tie");
  assert.deepEqual(ids(forward.results), ["a", "b"]);
  assert.deepEqual(ids(reversed.results), ["a", "b"], "arm order must not change the order");
});

test("rank, not position of first appearance, drives the score", () => {
  // 'later' is second in both lists and 'earlier' is first in both, so
  // 'earlier' must win even though it appears in the same arm. This is the
  // check that the denominator uses the per-result rank: hoisting the
  // division out of the loop would make these tie, which reads as harmless
  // and is not.
  const { results } = fuse({
    arms: { vector: [{ id: "earlier" }, { id: "later" }], bm25: [{ id: "earlier" }, { id: "later" }], graph: [], temporal: [] }
  });

  assert.ok(results[0].score > results[1].score);
  assert.deepEqual(ids(results), ["earlier", "later"]);
  assert.equal(results[0].arms.vector.rank, 1);
  assert.equal(results[1].arms.vector.rank, 2);
});

test("fusing identical input ten times gives identical output", () => {
  const arms = {
    vector: [{ id: "a" }, { id: "b" }, { id: "c" }],
    bm25: [{ id: "c" }, { id: "d" }],
    graph: [{ id: "b" }, { id: "e" }],
    temporal: [{ id: "a" }, { id: "e" }]
  };

  const runs = Array.from({ length: 10 }, () => ids(fuse({ arms }).results).join(","));
  assert.equal(new Set(runs).size, 1, `fusion is not deterministic: ${[...new Set(runs)]}`);
});

test("relative is normalised for reading and never affects order", () => {
  const { results } = fuse({
    arms: { vector: [{ id: "a" }, { id: "b" }], bm25: [], graph: [], temporal: [] }
  });

  assert.equal(results[0].relative, 1);
  assert.ok(results[1].relative < 1 && results[1].relative > 0);
  // Order comes from score alone; relative is derived.
  assert.ok(results[0].score > results[1].score);
});

test("a fused result carries no absolute confidence", () => {
  // RRF scores are rank-relative. A threshold on them means something
  // different at every result count, so `relative` is the only normalised
  // number and it is documented as unreadable-for-thresholds.
  const { results } = fuse({
    arms: { vector: [{ id: "a" }], bm25: [{ id: "a" }], graph: [], temporal: [] }
  });
  assert.ok(results[0].score > 0);
  assert.ok(results[0].relative <= 1);
});

test("fuse rejects a non-positive k rather than dividing by it", () => {
  assert.throws(() => fuse({ arms: {}, k: 0 }), RangeError);
  assert.throws(() => fuse({ arms: {}, k: -5 }), RangeError);
});

test("fuse rejects a missing arms object", () => {
  assert.throws(() => fuse({}), TypeError);
});

test("a result with no id is skipped rather than keyed on undefined", () => {
  const { results } = fuse({
    arms: { vector: [{ id: "a" }, { noId: true }, { id: null }], bm25: [], graph: [], temporal: [] }
  });
  assert.deepEqual(ids(results), ["a"]);
});

// ---------------------------------------------------------------------------
// describeArms
// ---------------------------------------------------------------------------

test("a skipped arm and an arm that matched nothing are reported differently", () => {
  // This is the Phase 3 gate in miniature. Both look like "no results" from
  // outside, and they call for completely different investigations: one is an
  // index or data problem, the other is a configuration or provider problem.
  const report = describeArms(
    { vector: [{ id: "a" }], bm25: [], graph: null, temporal: [] },
    DEFAULT_WEIGHTS,
    {
      vector: { ran: true },
      graph: { ran: false, reason: "no seeds: arms 1 and 2 matched nothing" }
    }
  );

  assert.equal(report.vector.ran, true);
  assert.equal(report.vector.hits, 1);

  assert.equal(report.bm25.ran, true, "ran and found nothing");
  assert.equal(report.bm25.hits, 0);

  assert.equal(report.graph.ran, false);
  assert.match(report.graph.reason, /no seeds/);
});

test("the report always names all four arms", () => {
  const report = describeArms({ vector: [] }, DEFAULT_WEIGHTS, {});
  assert.deepEqual(Object.keys(report).sort(), ["bm25", "graph", "temporal", "vector"]);
  assert.equal(report.vector.ran, true);
  assert.equal(report.bm25.ran, false);
  assert.equal(report.bm25.reason, "not attempted");
});

test("the report carries the weight so a disabled arm is visible", () => {
  const report = describeArms({ vector: [] }, { ...DEFAULT_WEIGHTS, vector: 0 }, {});
  assert.equal(report.vector.weight, 0);
});

// ---------------------------------------------------------------------------
// Temporal: validity
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00Z");

test("an item with no bounds is valid now", () => {
  assert.equal(isValidAt({ recorded_at: NOW.toISOString() }, NOW), true);
});

test("a fact that ended before the reference is not valid", () => {
  const item = {
    recorded_at: "2026-01-01T00:00:00Z",
    occurred_end: "2026-03-01T00:00:00Z"
  };
  assert.equal(isValidAt(item, NOW), false);
  assert.equal(isValidAt(item, new Date("2026-02-01T00:00:00Z")), true);
});

test("the validity window is half-open, so a boundary belongs to one side only", () => {
  // A fact ending exactly at noon was not true at noon. A closed interval
  // makes noon match both this item and its successor, which is how a query
  // for one moment returns two contradictory answers.
  const item = { recorded_at: "2026-01-01T00:00:00Z", occurred_end: "2026-06-15T12:00:00Z" };
  assert.equal(isValidAt(item, new Date("2026-06-15T12:00:00Z")), false);
  assert.equal(isValidAt(item, new Date("2026-06-15T11:59:59Z")), true);
});

test("a fact that starts after the reference is not valid", () => {
  const item = { recorded_at: "2026-01-01T00:00:00Z", occurred_start: "2026-09-01T00:00:00Z" };
  assert.equal(isValidAt(item, NOW), false);
});

test("bitemporal: a fact learned after the reference is invisible at that moment", () => {
  // Learned in 2026 about something true in 2019. At a 2019 reference it did
  // not exist, so it cannot inform the answer — and that is exactly the
  // difference between "what was true in 2019" and "what I believed in 2019".
  const item = {
    recorded_at: "2026-06-01T00:00:00Z",
    occurred_start: "2019-01-01T00:00:00Z"
  };

  assert.equal(isValidAt(item, new Date("2019-06-01T00:00:00Z")), false);
  assert.equal(isValidAt(item, new Date("2026-06-02T00:00:00Z")), true);
});

test("an invalidated fact stays available for a past query", () => {
  const item = {
    recorded_at: "2026-01-01T00:00:00Z",
    occurred_start: "2026-01-01T00:00:00Z",
    invalidated_at: "2026-05-01T00:00:00Z"
  };

  assert.equal(isValidAt(item, new Date("2026-03-01T00:00:00Z")), true);
  assert.equal(isValidAt(item, new Date("2026-06-01T00:00:00Z")), false);
});

test("an unparseable timestamp is read as absent, not as a bound", () => {
  // A garbage date is not a date. Treating it as "no bound" is what keeps a
  // corrupted import from silently excluding or including everything; the
  // asymmetry below is the deliberate part.
  assert.equal(isValidAt({ recorded_at: "not a date", occurred_start: "also not" }, NOW), true);

  // A *parseable* bound still applies, even alongside a garbage one.
  assert.equal(isValidAt({ recorded_at: "nope", occurred_start: "2099-01-01" }, NOW), false);
  assert.equal(isValidAt({ recorded_at: "nope", occurred_end: "2020-01-01" }, NOW), false);

  // Garbage everywhere reads as no bound at all, so there is no evidence
  // against validity. Returning false here would hide every legacy item that
  // predates the bitemporal columns, which is every item from the migration.
  assert.equal(isValidAt({ recorded_at: "nope" }, NOW), true);
  assert.equal(isValidAt({ recorded_at: "" }, NOW), true);
});

// ---------------------------------------------------------------------------
// Temporal: recency
// ---------------------------------------------------------------------------

test("recency halves at the half-life", () => {
  const recent = { recorded_at: NOW.toISOString() };
  const oneHalfLife = { recorded_at: new Date(NOW - 180 * DAY).toISOString() };

  assert.equal(recency(recent, { at: NOW }), 1);
  assert.ok(Math.abs(recency(oneHalfLife, { at: NOW }) - 0.5) < 1e-9);
});

test("recency of something dated in the future is 1, not greater", () => {
  const future = { recorded_at: new Date(NOW + 30 * DAY).toISOString() };
  assert.equal(recency(future, { at: NOW }), 1);
});

test("an undated item is not scored as stale", () => {
  // Absence of information is not evidence of staleness. Scoring it 0 would
  // bury it below every dated item regardless of content.
  assert.equal(recency({}, { at: NOW }), 0.5);
  assert.equal(recency({ recorded_at: null }, { at: NOW }), 0.5);
});

test("recency can read the occurrence date instead of the learning date", () => {
  // A memory learned today about something from 2019: recent knowledge, old
  // event. Which one the caller means is the difference between "what do I
  // know" and "what happened lately".
  const item = {
    recorded_at: NOW.toISOString(),
    occurred_start: new Date(NOW - 730 * DAY).toISOString()
  };

  assert.equal(recency(item, { at: NOW, basis: "learned" }), 1);
  assert.ok(recency(item, { at: NOW, basis: "occurred" }) < 0.1);
});

test("recency rejects a non-positive half-life", () => {
  assert.throws(() => recency({}, { at: NOW, halfLifeDays: 0 }), RangeError);
  assert.throws(() => recency({}, { at: NOW, halfLifeDays: -1 }), RangeError);
});

test("rankTemporally is stable and reports why an item scored as it did", () => {
  const items = [
    { id: "old", recorded_at: new Date(NOW - 720 * DAY).toISOString(), item: { importance: 0.5 } },
    { id: "new", recorded_at: NOW.toISOString(), item: { importance: 0.5 } },
    { id: "undated", item: { importance: 0.5 } }
  ];

  const ranked = rankTemporally(items, { at: NOW });
  assert.equal(ranked[0].id, "new");
  assert.equal(ranked.at(-1).id, "old");
  assert.equal(ranked.find((r) => r.id === "undated").temporal.undated, true);

  const runs = Array.from({ length: 10 }, () => ids(rankTemporally(items, { at: NOW })).join(","));
  assert.equal(new Set(runs).size, 1);
});

test("an equal-recency tie is broken by importance, then by id", () => {
  const items = [
    { id: "b", recorded_at: NOW.toISOString(), item: { importance: 0.5 } },
    { id: "a", recorded_at: NOW.toISOString(), item: { importance: 0.5 } },
    { id: "c", recorded_at: NOW.toISOString(), item: { importance: 0.9 } }
  ];
  const ranked = ids(rankTemporally(items, { at: NOW }));
  assert.deepEqual(ranked, ["c", "a", "b"]);
});

// ---------------------------------------------------------------------------
// Temporal: filtering
// ---------------------------------------------------------------------------

test("with no reference moment, invalidated items are excluded", () => {
  const items = [
    { id: "ok", invalidated_at: null },
    { id: "gone", invalidated_at: "2026-05-01T00:00:00Z" }
  ];
  assert.deepEqual(ids(filterValidAt(items, null)), ["ok"]);
});

test("includeInvalidated asks for the history", () => {
  const items = [{ id: "ok" }, { id: "gone", invalidated_at: "2026-05-01T00:00:00Z" }];
  assert.deepEqual(ids(filterValidAt(items, null, { includeInvalidated: true })), ["ok", "gone"]);
});

test("a deleted item is excluded even for a past query", () => {
  // A deletion is a statement about the record, not about the world. The user
  // asked for that fact to be gone; honouring it retroactively is a surprise.
  const items = [
    { id: "kept", deleted_at: null },
    { id: "deleted", deleted_at: "2026-05-01T00:00:00Z" }
  ];

  const past = new Date("2026-02-01T00:00:00Z");
  assert.deepEqual(ids(filterValidAt(items, past)), ["kept"]);
  assert.deepEqual(ids(filterValidAt(items, past, { includeDeleted: true })), ["kept", "deleted"]);
});

test("a past query finds a fact invalidated since", () => {
  const items = [
    {
      id: "was-true",
      recorded_at: "2026-01-01T00:00:00Z",
      occurred_start: "2026-01-01T00:00:00Z",
      invalidated_at: "2026-05-01T00:00:00Z"
    }
  ];

  assert.equal(filterValidAt(items, new Date("2026-03-01T00:00:00Z")).length, 1);
  assert.equal(filterValidAt(items, NOW).length, 0);
});

test("filterValidAt accepts either a bare item or a fusion entry", () => {
  const bare = [{ id: "a", invalidated_at: null }];
  const wrapped = [{ id: "a", item: { invalidated_at: null } }];
  assert.equal(filterValidAt(bare, null).length, 1);
  assert.equal(filterValidAt(wrapped, null).length, 1);
});
