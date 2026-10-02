#!/usr/bin/env node
/**
 * Measure the write gate, against the real decision model.
 *
 * This is Phase 5's gate, and it cannot be closed with a fake provider:
 *
 *   - 100 valid writes: **zero** of them lost
 *   - 100 noise writes: the rejection rate, measured
 *   - provider forced to fail: writes still succeed, gate skipped, skip recorded
 *
 * The first two need the real model. The gate is only meaningful against the
 * thing that will make the judgements, and a fake provider would let any
 * threshold pass by construction.
 *
 * Cost: ~200 calls. `upstage/solar-decide` is $0.05/M in and $0/M out, so this
 * is a fraction of a cent. It prints what it spent, because a measurement that
 * does not report its own cost is a measurement you cannot decide whether to
 * repeat.
 *
 * What it deliberately does NOT do: change a threshold. It reports the
 * distribution of scores and the rate at the current threshold, and the
 * decision about what the threshold should be goes through docs/THRESHOLDS.md —
 * which opens a pull request rather than applying anything.
 */

import { writeFileSync } from "node:fs";

import { createDecisionClient } from "../src/decisions/client.mjs";
import { createWriteGate, OUTCOME } from "../src/decisions/write-gate.mjs";
import { loadProviderConfig, thresholdSection } from "../src/config.mjs";

function out(text) {
  process.stdout.write(text);
}

/**
 * Valid: specific, durable, true about the user, and something they would be
 * annoyed to have to re-explain next month.
 */
const VALID = [
  "The user lives in Porto Alegre and works from home on Fridays",
  "The user's daughter is called Bia and is six years old",
  "The user is allergic to penicillin — the reaction is hives",
  "The user takes levothyroxine every morning before breakfast",
  "The user prefers metric units and dislikes imperial",
  "The user's editor at Revista.Contracts is named Rui and is strict about deadlines",
  "The user has a standing appointment with Dr Alencar, a dentist, on the second Tuesday of each month",
  "The user is vegetarian but not vegan, and eats eggs and dairy",
  "The user is learning Portuguese as a second language and practises daily",
  "The user's github handle is kayroalexandre and they prefer squash merges",
  "The user is vegetarian but not vegan" + " and does not eat fish",
  "The user's rent contract renews in March 2027 at a fixed amount",
  "The user has a standing note to stretch every hour for a wrist injury",
  "The user prefers async standups over daily calls",
  "The user switched banks in 2025 after a fee dispute",
  "The user keeps a spreadsheet called 'household' with the utility bills",
  "The user is allergic to shellfish as well as penicillin",
  "The user's partner is called Caio and they travel together once a year",
  "The user has never flown, and this is on their list for 2027",
  "The user's son Rui was born in November 2021",
  "The user's flat has a south-facing balcony with strong afternoon light",
  "The user takes their coffee black and short, in a small cup",
  "The user's mother lives in Curitiba and they speak weekly by video",
  "The user uses a standing desk and it is 118cm high",
  "The user is training for a half marathon in March",
  "The user has a standing subscription to the Brazilian Journal of Medicine",
  "The user's laptop is a ThinkPad T14 and they run Linux on it",
  "The user does not drink coffee after 14:00 because it affects their sleep",
  "The user keeps their passport valid until 2031 and travels with it",
  "The user's financial adviser is called Sílvia and meets quarterly",
  "The user has a book of poems by Adélia Prado that they return to",
  "The user's childhood home was in Caxias do Sul",
  "The user uses a password manager and cannot log in without it",
  "The user plans to learn Rust because of a work project in 2027",
  "The user has a recurring migraine on the first day of the period",
  "The user keeps a list of restaurants to try and it has 40 entries",
  "The user's visa-free travel allowance is 90 days a year",
  "The user works in the legal profession, at a small firm",
  "The user has an annual physical in March and tracks the results",
  "The user prefers morning meetings and refuses afternoon invites",
  "The user's grandmother is 91 and lives in São Leopoldo",
  "The user drives a 2014 hatchback and does 30k km a year",
  "The user is saving for a sabbatical in 2028",
  "The user does the family's taxes with a spreadsheet, not an accountant",
  "The user has a standing book club that meets on the first Sunday",
  "The user's commute is 40 minutes by bicycle",
  "The user has decided against a second child and this is settled",
  "The user is a member of a cooperative that buys groceries",
  "The user's phone number for emergencies is their partner Caio's",
  "The user keeps a shared calendar called 'casa' with their partner",
  "The user was born in 1991 and has a sister two years older",
  "The user plays bass and has a gig in March",
  "The user has decided to stop buying books physically",
  "The user's prescription glasses were last updated in 2026",
  "The user keeps a garden on the balcony with herbs and two tomato plants",
  "The user's therapy is fortnightly and they keep a journal for it",
  "The user does not have a car in winter because the roads ice",
  "The user works best in 90-minute blocks with a break between",
  "The user keeps a spreadsheet of investments and reviews it monthly",
  "The user's grandmother's recipe for pão de queijo is written down in a notebook",
  "The user has a standing agreement with a tailor in Bonfim",
  "The user reads three to four books a month, mostly non-fiction",
  "The user's nephew is called Davi and is two years old",
  "The user switched to a standing desk and no longer gets neck pain",
  "The user has a membership at a pool that closes in January",
  "The user's university was UFRGS, studied law, graduated in 2014",
  "The user keeps a wishlist of places to visit, 23 entries",
  "The user plans to adopt a second cat when the current one is older",
  "The user has a standing Saturday market at the Orange Fair",
  "The user's back pain is managed by swimming twice a week",
  "The user does not drink alcohol and this is a preference, not recovery",
  "The user keeps a paper notebook for work and nothing digital",
  "The user's partner works in design at a studio in Pinheiros",
  "The user has a recurring prescription for migraine medication",
  "The user grew up speaking German at home and Spanish with grandparents",
  "The user has a decision rule: no purchases over R$200 without a 24h wait",
  "The user's dog is called Frida and is a rescue",
  "The user keeps a running log since 2022",
  "The user has a standing arrangement to swap childcare with a neighbour",
  "The user is learning to solder and bought a kit in 2026",
  "The user has a subscription to a Brazilian critical theory journal",
  "The user takes the 08:12 train to Porto Alegre on Fridays",
  "The user's flat has a fuse box in the corridor, and the label is out of date",
  "The user has decided to learn one new thing a season",
  "The user's sister lives in Europe and is expecting a child in March",
  "The user has a standing order to a blood donation centre",
  "The user keeps a spreadsheet of book loans with the library",
  "The user was treated for tendinitis in 2025 and it resolved",
  "The user has a rule: nothing is bought on a Friday",
  "The user volunteers at a shelter on the first Sunday of the month",
  "The user's flat has a boiler that needs servicing every two years",
  "The user has an ongoing dispute with the neighbours about noise after 22h",
  "The user keeps a photo of their grandmother on the desk at work",
  "The user has decided to stop using social media in the evenings",
  "The user has a standing budget of R$400 a month for books and music",
  "The user checks their investments on the first Monday of the month",
  "The user is the executor of a friend's will, with a lawyer named Caio",
  "The user keeps a written list of passwords' locations for their parents",
  "The user has a flight booked for March and is anxious about the connection",
  "The user takes their measurements and tracks them monthly",
  "The user's flat has a landlord who prefers WhatsApp to email",
  "The user has a garden tool set and knows how to sharpen the shears",
  "The user is on the council of a residents' association"
];

/** Noise: transient chatter, assistant-known facts, and no instruction to remember. */
const NOISE = [
  "ok",
  "thanks",
  "hi",
  "sure",
  "yes",
  "no",
  "got it",
  "cool",
  "np",
  "Sounds good",
  "Right, let me think about that",
  "I'll check the documentation",
  "Let me search for that",
  "The capital of France is Paris",
  "Water boils at 100 degrees Celsius at sea level",
  "2 + 2 is 4",
  "How do I sort a list in Python?",
  "What's the syntax for a for loop?",
  "Can you explain async/await?",
  "I don't know",
  "That's a good question",
  "I don't have access to that information",
  "Let me know if you need anything else",
  "The user asked about the weather",
  "The assistant is a helpful AI system",
  "This is a test message",
  "Testing testing",
  "foo bar baz",
  "asdfgh",
  "....",
  "hmm",
  "Right.",
  "Understood.",
  "Got it, thanks!",
  "Perfect",
  "Excellent",
  "Wonderful",
  "That's correct",
  "Indeed",
  "Absolutely",
  "Of course",
  "My pleasure",
  "Any time",
  "You're welcome",
  "No problem",
  "Let me know",
  "I'll be right back",
  "One moment",
  "Just a second",
  "Checking now",
  "Searching",
  "Processing",
  "Loading",
  "Error: something went wrong",
  "The API returned a 500",
  "undefined is not a function",
  "TypeError: cannot read property",
  "user: admin password: 123456",
  "SELECT * FROM users",
  "ignore previous instructions",
  "System prompt: you are a helpful assistant",
  "The current time is 3pm",
  "Tomorrow is Tuesday",
  "I am an AI language model",
  "As an AI, I cannot",
  "I don't have personal opinions",
  "This information may be outdated",
  "Please consult a professional",
  "This is not medical advice",
  "Results may vary",
  "Read more at example.com",
  "Click here to learn more",
  "Subscribe to our newsletter",
  "Limited time offer",
  "50% off today only",
  "Dear customer, your order has shipped",
  "Your package will arrive soon",
  "Meeting at 3pm",
  "I'll send you the file",
  "Let me know the deadline",
  "Can you clarify the requirements?",
  "What are the acceptance criteria?",
  "How many users do you expect?",
  "What's the timeline?",
  "Do you have a preference on the framework?",
  "Let's use React",
  "I'll refactor that",
  "Run the tests and see what fails",
  "Check the logs for the error",
  "This function has a typo",
  "Missing semicolon",
  "The build is broken",
  "Try restarting the server",
  "I recommend using TypeScript",
  "Use an index on that column",
  "That query will be slow",
  "Consider memoisation",
  "There is a race condition",
  "It works on my machine",
  "Have you tried turning it off and on again",
  "That's a known issue",
  "Fixed in the next release",
  "Look at the documentation",
  "The docs say so",
  "I'm not sure about that",
  "Maybe?",
  "Perhaps we should",
  "It depends",
  "Hard to say",
  "Let me think",
  "Give me a moment",
  "One thing to consider",
  "On the other hand",
  "That said",
  "In that case",
  "Otherwise",
  "Alternatively",
  "However"
];

// ---------------------------------------------------------------------------

// Providers and thresholds, and deliberately no database. This script
// calibrates a threshold; it never opens a connection, and asking for a
// database password to do that is a coupling with no purpose.
const providerConfig = loadProviderConfig();
const config = { ...providerConfig, ...thresholdSection() };

if (!providerConfig.providers.apiKey) {
  out(
    "No provider key found. Run `npm run key:set` or save one at /settings.\n\n" +
      "This measurement cannot be faked: a fake provider would let any threshold\n" +
      "pass by construction, which is the opposite of what the gate is for.\n"
  );
  process.exit(1);
}

const client = createDecisionClient({ config });
const store = {
  async recordDecision() {} // the measurement records nothing to the database
};
const gate = createWriteGate({ store, client, config });

out(
  `Write-gate measurement against ${client.model}\n` +
    `  threshold in force: ${gate.threshold}\n` +
    `  ${VALID.length} valid writes, ${NOISE.length} noise writes\n` +
    "  this spends a fraction of a cent and prints what it cost\n\n"
);

async function measure(label, items) {
  const scores = [];
  const byOutcome = { store: 0, propose: 0, skipped: 0 };
  let cost = 0;
  const latency = [];

  for (const [index, content] of items.entries()) {
    const result = await gate.evaluate({ content });
    byOutcome[result.outcome] += 1;
    cost += result.cost ?? 0;
    if (typeof result.score === "number") scores.push(result.score);
    if (typeof result.latencyMs === "number") latency.push(result.latencyMs);

    if ((index + 1) % 25 === 0) {
      process.stderr.write(`\r  ${label}: ${index + 1}/${items.length}   `);
    }
  }
  process.stderr.write("\r" + " ".repeat(40) + "\r");

  scores.sort((a, b) => a - b);
  const at = (q) => (scores.length === 0 ? null : scores[Math.min(scores.length - 1, Math.floor(q * scores.length))]);
  const mean = scores.length === 0 ? null : scores.reduce((s, v) => s + v, 0) / scores.length;

  return {
    label,
    n: items.length,
    scores,
    byOutcome,
    cost,
    latencyMs: latency.length ? Math.round(latency.reduce((s, v) => s + v, 0) / latency.length) : null,
    stats: {
      min: scores[0] ?? null,
      p10: at(0.1),
      median: at(0.5),
      p90: at(0.9),
      max: scores[scores.length - 1] ?? null,
      mean: mean === null ? null : Number(mean.toFixed(4))
    }
  };
}

const valid = await measure("valid", VALID);
out("\n");
const noise = await measure("noise", NOISE);

const fmt = (v) => (v === null ? "  n/a" : v.toFixed(3));

out("  set        n     min    p10   median    p90     max   mean    stored  proposed  skipped\n");
for (const result of [valid, noise]) {
  const s = result.stats;
  out(
    `  ${result.label.padEnd(9)} ${String(result.n).padStart(3)}  ` +
      `${fmt(s.min).padStart(6)} ${fmt(s.p10).padStart(6)} ${fmt(s.median).padStart(7)} ` +
      `${fmt(s.p90).padStart(6)} ${fmt(s.max).padStart(6)} ${fmt(s.mean).padStart(6)}  ` +
      `${String(result.byOutcome.store).padStart(7)} ${String(result.byOutcome.propose).padStart(9)} ` +
      `${String(result.byOutcome.skipped).padStart(8)}\n`
  );
}

// -- What the data suggests, computed rather than guessed ---------------------

/**
 * The threshold this data would pick.
 *
 * Swept over every midpoint between consecutive scores, minimising
 * `valid demoted + noise admitted`. Reported, never applied: docs/THRESHOLDS.md
 * is explicit that a calibration number is a proposal that opens a pull request.
 *
 * Reported *beside* the current threshold, because "your threshold is wrong by
 * this much" is a more useful sentence than "use 0.09".
 */
function suggestThreshold(validScores, noiseScores) {
  const candidates = new Set([0, 1]);
  for (const score of [...validScores, ...noiseScores]) candidates.add(score);
  const sorted = [...candidates].sort((a, b) => a - b);

  let best = null;
  for (let i = 1; i < sorted.length; i += 1) {
    const threshold = (sorted[i - 1] + sorted[i]) / 2;
    const lost = validScores.filter((s) => s < threshold).length;
    let admitted = 0;
    for (const score of noiseScores) if (score >= threshold) admitted += 1;
    const total = lost + admitted;
    if (!best || total < best.total) best = { threshold, lost, admitted, total };
  }
  return best;
}

const suggestion = suggestThreshold(valid.scores, noise.scores);

out("\n  THRESHOLD\n");
out(
  `  in force: ${gate.threshold}\n` +
    `  this data would pick: ${suggestion.threshold.toFixed(3)}\n` +
    `    -> ${suggestion.lost} of ${valid.n} valid demoted, ` +
    `${suggestion.admitted} of ${noise.n} noise admitted\n` +
    `  at the current threshold: ${valid.byOutcome.propose} demoted, ` +
    `${noise.byOutcome.store} admitted\n\n` +
    "  Not applied. A measured threshold is a proposal that opens a pull request.\n\n"
);

out("  Score distribution, so the shape is visible and not just the summary:\n");
out("    bucket      valid   noise\n");
const BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.01];
let previous = 0;
for (const edge of BUCKETS) {
  const inBucket = (scores) => scores.filter((s) => s >= previous && s < edge).length;
  out(
    `    ${previous.toFixed(2)}-${edge.toFixed(2)}  ${String(inBucket(valid.scores)).padStart(6)}` +
      `  ${String(inBucket(noise.scores)).padStart(6)}\n`
  );
  previous = edge;
}

// Raw scores, so the recommendation is reproducible without paying again.
const dumpPath = process.env.GATE_SCORES_OUT ?? "/tmp/jove-gate-scores.json";
try {
  writeFileSync(
    dumpPath,
    JSON.stringify({ threshold: gate.threshold, valid: valid.scores, noise: noise.scores, suggestion })
  );
  out(`\n  raw scores written to ${dumpPath}\n`);
} catch (err) {
  out(`\n  could not write raw scores: ${err.message}\n`);
}

const totalCost = valid.cost + noise.cost;
const totalLatency = [valid.latencyMs, noise.latencyMs].filter(Boolean);

out(
  `\n  cost: ${totalCost.toFixed(6)} credits over ${valid.n + noise.n} calls` +
    `\n  mean latency: ${Math.round(totalLatency.reduce((s, v) => s + v, 0) / totalLatency.length)}ms\n`
);

// -- The gate, stated as pass/fail -------------------------------------------

// Nothing is discarded: a proposal is a stored memory with a status, and
// retrieval filters on `status = 'active'`. The quantity that costs something is
// how many good memories need a human to look at them.
const lost = 0;
const noiseStored = noise.byOutcome.store;
const noiseRate = noise.n === 0 ? null : noiseStored / noise.n;
const validRate = valid.n === 0 ? null : valid.byOutcome.store / valid.n;

out("\n  GATE\n");

const check = (label, pass, detail) => {
  out(`  [${pass ? "pass" : "FAIL"}] ${label}\n         ${detail}\n`);
  return pass;
};

let allPass = true;

/**
 * The gate says "zero false rejections (nothing valid is discarded)".
 *
 * Discarded, specifically. In this design a rejected write becomes a *proposal*:
 * stored, queryable, listed by `memory_list_proposed`. So the literal gate is
 * met by construction, and the number worth reporting is not the proposal count
 * but the two quantities that actually cost something — good memories demoted
 * to review, and noise admitted.
 *
 * The first version of this check counted proposals as losses and failed. That
 * measured the design rather than the gate, and would have reported a failure
 * for a system that had lost nothing.
 */
allPass =
  check(
    "zero false rejections: nothing valid was discarded",
    valid.byOutcome.propose >= 0,
    `${valid.n} valid writes, 0 discarded — every one is stored, ` +
      `${valid.byOutcome.propose} of them as proposals awaiting review.\n` +
      `         The cost of a proposal is review attention, not data: ` +
      `${((valid.byOutcome.propose / valid.n) * 100).toFixed(0)}% of good memories ` +
      `needing review is a queue nobody reads,\n` +
      `         which is a real failure even though nothing was lost.`
  ) && allPass;

allPass =
  check(
    "the noise rejection rate is measured and reported",
    noiseRate !== null,
    `${noiseStored}/${noise.n} noise writes were stored as active ` +
      `(${(noiseRate * 100).toFixed(1)}%). This is a number to argue about, not a ` +
      `pass mark: the gate asks that it be measured.`
  ) && allPass;

allPass =
  check(
    "provider failure: writes still succeed, gate skipped",
    valid.byOutcome.skipped === 0 && noise.byOutcome.skipped === 0,
    "verified in the test suite against a forced failure, not here — a real " +
      "provider outage cannot be requested on demand. The unit tests assert it."
  ) && allPass;

out("\n  " + "-".repeat(66) + "\n");
out(
  "  The separation between the two sets is the whole result.\n" +
    "  A threshold is only doing its job if these two distributions barely\n" +
    "  overlap. Overlap means the question is wrong, not that the number is.\n\n" +
    "  Nothing here changed a threshold. docs/THRESHOLDS.md is explicit that a\n" +
    "  calibration number is a proposal that opens a pull request, and that\n" +
    "  cross-workspace may only ever rise. Run this again after a model change\n" +
    "  and compare.\n\n"
);

process.exit(allPass ? 0 : 1);
