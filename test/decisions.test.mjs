import { test } from "node:test";
import assert from "node:assert/strict";

import { createDecisionClient, isRetryableStatus, DecisionRequestError, contextHash, NOUL } from "../src/decisions/client.mjs";
import { createWriteGate, OUTCOME, DEFAULT_WRITE_GATE_THRESHOLD } from "../src/decisions/write-gate.mjs";
import { loadConfig } from "../src/config.mjs";

/**
 * The decision client and the write gate, with no network.
 *
 * A suite that spent money on every run would not get run, and a test that only
 * passes while a third party is up is a test that measures the third party.
 * What is tested here is every decision this code makes: which failures are
 * worth retrying, how a malformed answer is treated, and above all the
 * difference between "the model said no" and "we could not ask" — which are the
 * same absence of a positive and call for opposite responses.
 */

const DIMS = 3072;
const config = loadConfig({
  POSTGRES_PASSWORD: "unused",
  OPENROUTER_API_KEY: "test-key-never-sent",
  HOME: "/nonexistent-jove-test-home",
  JOVE_SECRETS_DIR: undefined,
  OPENROUTER_API_KEY_FILE: undefined,
  PARADIGM_EMBED_DIMENSIONS: String(DIMS)
});

/** A fake System One provider. */
function fakeProvider({ status = 200, answers = null, failTimes = 0, body = null } = {}) {
  const calls = [];
  let remaining = failTimes;

  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers });
    if (remaining > 0) {
      remaining -= 1;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    }
    if (status !== 200) {
      return new Response(JSON.stringify(body ?? { error: { message: "no" } }), { status });
    }
    const asked = Object.keys(JSON.parse(init.body).questions);
    return new Response(
      JSON.stringify({
        id: "gen-dec-1",
        model: "upstage/solar-decide-20260901",
        provider: "Upstage",
        answers:
          answers ??
          Object.fromEntries(asked.map((k) => [k, { type: NOUL, noul: 0.9 }])),
        usage: { input_tokens: 300, output_tokens: 20, cost: 0.00003 }
      }),
      { status: 200 }
    );
  };

  return { impl, calls };
}

const noSleep = async () => {};

/**
 * A store that records decisions.
 *
 * Mirrors the real store's field mapping — `applied` becomes `was_applied` —
 * so a shape mismatch between the gate and the store is caught here rather than
 * by a column that silently stays false. The first version stored the record
 * verbatim, and a test asserting `was_applied` failed for a reason that pointed
 * at the wrong file.
 */
function fakeStore() {
  const decisions = [];
  return {
    decisions,
    async recordDecision(record) {
      decisions.push({
        operation: record.operation,
        model: record.model,
        question_key: record.questionKey,
        question_type: record.questionType,
        noul_score: record.noul,
        was_applied: record.applied ?? false,
        threshold_used: record.threshold,
        context_hash: record.contextHash,
        latency_ms: record.latencyMs,
        outcome: record.outcome ?? null
      });
    }
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

test("a request goes to the System One endpoint, not the chat one", async () => {
  const provider = fakeProvider();
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  await client.decide({
    state: "The user prefers metric units",
    questions: { worth: { type: NOUL, instructions: "Is this worth keeping?" } }
  });

  // The wrong endpoint returns a plausible-looking error, or worse, nothing.
  assert.equal(provider.calls[0].url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(provider.calls[0].body.model, "upstage/solar-decide");
  assert.equal(provider.calls[0].body.questions.worth.type, "noul");
});

test("the model that actually served the request is reported, not the one asked for", async () => {
  // The provider may route to a dated snapshot. A calibration number is only
  // reproducible if the exact id is known.
  const provider = fakeProvider();
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  const result = await client.decide({
    state: "x",
    questions: { worth: { type: NOUL, instructions: "y" } }
  });

  assert.equal(result.requestedModel, "upstage/solar-decide");
  assert.equal(result.model, "upstage/solar-decide-20260901");
  assert.equal(client.identity(), "upstage/solar-decide@systemone-v1");
});

test("cost and token usage come back, because thresholds are calibrated against cost", async () => {
  const provider = fakeProvider();
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  const result = await client.decide({
    state: "x",
    questions: { worth: { type: NOUL, instructions: "y" } }
  });

  assert.equal(result.cost, 0.00003);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.latencyMs >= 0, true);
});

test("a 401 fails immediately rather than after retries", async () => {
  const provider = fakeProvider({ status: 401 });
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  await assert.rejects(
    () => client.decide({ state: "x", questions: { w: { type: NOUL, instructions: "y" } } }),
    (err) => {
      assert.ok(err instanceof DecisionRequestError);
      assert.equal(err.attempts, 1);
      assert.match(err.message, /API key is missing, wrong, or expired/);
      return true;
    }
  );
  assert.equal(provider.calls.length, 1);
});

test("only 'not now' statuses are retried", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 524, 529]) {
    assert.equal(isRetryableStatus(status), true, `${status} should retry`);
  }
  for (const status of [400, 401, 402, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not retry`);
  }
});

test("a question with no instructions is refused before a request is made", async () => {
  // An empty instruction produces a confident answer to a question nobody
  // asked, and it does not look wrong.
  const provider = fakeProvider();
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  await assert.rejects(
    () => client.decide({ state: "x", questions: { w: { type: NOUL, instructions: "  " } } }),
    /needs instructions/
  );
  await assert.rejects(() => client.decide({ state: "", questions: { w: { type: NOUL, instructions: "y" } } }), /state/);
  await assert.rejects(() => client.decide({ state: "x", questions: {} }), /at least one question/);
  assert.equal(provider.calls.length, 0);
});

test("a choice where a noul was asked is refused, not coerced into a score", async () => {
  // The failure this prevents: a caller treats a non-null answer as a
  // probability, and a category name ends up in a score field. It surfaces much
  // later as a threshold behaving like a boolean.
  const provider = fakeProvider({ answers: { worth: { type: "choice", choice: "billing" } } });
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  const result = await client.decide({
    state: "x",
    questions: { worth: { type: NOUL, instructions: "y" } }
  });

  assert.equal(result.answers.worth.type, "choice");
  assert.equal(result.answers.worth.noul, undefined, "no number to mistake for a probability");
});

test("an out-of-range noul is reported rather than clamped", async () => {
  // Clamping silently would hide a miscalibrated model, and the point of a
  // calibrated probability is that it can be checked.
  const provider = fakeProvider({ answers: { worth: { type: NOUL, noul: 1.4 } } });
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  const result = await client.decide({
    state: "x",
    questions: { worth: { type: NOUL, instructions: "y" } }
  });

  assert.equal(result.answers.worth.noul, 1.4, "reported as received");
  assert.equal(result.answers.worth.inRange, false);
});

test("a non-numeric noul is refused", async () => {
  const provider = fakeProvider({ answers: { worth: { type: NOUL, noul: "high" } } });
  const client = createDecisionClient({ config, fetch: provider.impl, sleep: noSleep });

  await assert.rejects(
    () => client.decide({ state: "x", questions: { worth: { type: NOUL, instructions: "y" } } }),
    /no numeric noul/
  );
});

test("an HTML body with a 200 names the proxy", async () => {
  const impl = async () => new Response("<html>Gateway</html>", { status: 200 });
  const client = createDecisionClient({ config, fetch: impl, sleep: noSleep });

  await assert.rejects(
    () => client.decide({ state: "x", questions: { w: { type: NOUL, instructions: "y" } } }),
    /not JSON.*proxy/s
  );
});

test("no key is a clear refusal, and the message says there is no substitute", async () => {
  const provider = fakeProvider();
  const client = createDecisionClient({
    config: { ...config, providers: { ...config.providers, apiKey: "" } },
    fetch: provider.impl,
    sleep: noSleep
  });

  assert.equal(client.available(), false);
  await assert.rejects(
    () => client.decide({ state: "x", questions: { w: { type: NOUL, instructions: "y" } } }),
    /cannot fall back to anything local.*does not fall back to a chat model/s
  );
  assert.equal(provider.calls.length, 0);
});

test("the context hash is a hash, not the content", () => {
  const content = "my dentist is Dr Alencar and I go on tuesdays";
  const hash = contextHash(content);

  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(hash.includes("dentist"), false, "a personal detail must not land in the decision log");
  assert.equal(contextHash(content), hash, "deterministic, so repeats group");
  assert.notEqual(contextHash(`${content}.`), hash);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * `client: undefined` builds a real one from `provider`; `client: null` means
 * "there is no client", which is the state a keyless deployment is in and worth
 * testing. `??` conflates the two, and did — so the no-client test was quietly
 * exercising a working client and passing for the wrong reason.
 */
function gateWith({ provider, store = fakeStore(), threshold, client: injected, config: gateConfig = config } = {}) {
  const client =
    injected === undefined
      ? createDecisionClient({ config: gateConfig, fetch: provider?.impl ?? fakeProvider().impl, sleep: noSleep })
      : injected;
  return { gate: createWriteGate({ store, client, config: gateConfig, threshold }), store, client };
}

test("a score above the threshold is stored as active", async () => {
  const { gate, store } = gateWith({ provider: fakeProvider({ answers: { worth_storing: { type: NOUL, noul: 0.91 } } }) });

  const result = await gate.evaluate({ content: "The user prefers metric units" });

  assert.equal(result.outcome, OUTCOME.STORE);
  assert.equal(result.status, "active");
  assert.equal(result.skipped, false);
  assert.equal(store.decisions.length, 1, "recorded");
  assert.equal(store.decisions[0].was_applied, true);
  assert.equal(store.decisions[0].threshold_used, DEFAULT_WRITE_GATE_THRESHOLD);
  assert.equal(store.decisions[0].noul_score, 0.91, "the score, as the real column names it");
});

test("a score below the threshold is a PROPOSAL, not a discard", async () => {
  // The whole design. A memory system that discards on a model's say-so has a
  // data-loss bug whose frequency is the model's false-negative rate on the day.
  const { gate, store } = gateWith({ provider: fakeProvider({ answers: { worth_storing: { type: NOUL, noul: 0.12 } } }) });

  const result = await gate.evaluate({ content: "ok" });

  assert.equal(result.outcome, OUTCOME.PROPOSE);
  assert.equal(result.status, "proposed", "a queryable state, retrievable by whoever reviews");
  assert.match(result.reason, /not discarded/);
  assert.equal(store.decisions.length, 1, "and the judgement is still recorded");
});

test("a provider failure skips the gate and does NOT look like a rejection", async () => {
  // The distinction the whole module turns on. From the caller's side a
  // rejection and an outage are the same absence of a positive, and only one of
  // them is a judgement.
  const { gate } = gateWith({ provider: fakeProvider({ failTimes: 99 }) });

  const result = await gate.evaluate({ content: "The user prefers metric units" });

  assert.equal(result.outcome, OUTCOME.SKIPPED);
  assert.equal(result.status, "active", "the memory is stored");
  assert.equal(result.skipped, true);
  assert.equal(result.score, null, "no score, because nothing was asked");
  assert.match(result.reason, /provider unavailable/);
  // The 503 must not have become the memory's status.
  assert.equal(result.status, "active");
  assert.equal(result.providerError.httpStatus, 503);
});

test("no provider at all is a skip, and the memory is stored", async () => {
  const { gate } = gateWith({ client: null });
  const result = await gate.evaluate({ content: "The user prefers metric units" });

  assert.equal(result.outcome, OUTCOME.SKIPPED);
  assert.equal(result.status, "active");
  assert.match(result.reason, /no decision provider configured/);
});

test("a malformed answer is a skip, not a low score", async () => {
  // Treating a missing probability as a low one would make every provider
  // hiccup quietly demote writes to proposals.
  const { gate } = gateWith({
    provider: fakeProvider({ answers: { worth_storing: { type: "choice", choice: "billing" } } })
  });

  const result = await gate.evaluate({ content: "something" });

  assert.equal(result.outcome, OUTCOME.SKIPPED);
  assert.equal(result.status, "active");
  assert.match(result.reason, /no usable answer/);
});

test("empty content is a skip, and no decision row is written", async () => {
  // An empty write is a caller bug. Recording it as a gate decision would put
  // a spurious row in the calibration substrate.
  const { gate, store } = gateWith({ provider: fakeProvider() });

  const result = await gate.evaluate({ content: "   " });

  assert.equal(result.outcome, OUTCOME.SKIPPED);
  assert.match(result.reason, /nothing to judge/);
  assert.equal(store.decisions.length, 0);
});

test("a failed audit write does not fail the memory write", async () => {
  // The row is the calibration substrate, not the write path. Losing one costs
  // a data point; losing the write costs the memory.
  const broken = {
    async recordDecision() {
      throw new Error("decisions table is gone");
    }
  };
  const { gate } = gateWith({ provider: fakeProvider(), store: broken });

  const result = await gate.evaluate({ content: "The user prefers metric units" });

  assert.equal(result.outcome, OUTCOME.STORE);
  assert.equal(result.status, "active");
});

test("the content is never written to the decision log", async () => {
  const { gate, store } = gateWith({ provider: fakeProvider() });
  await gate.evaluate({ content: "my dentist is Dr Alencar" });

  const serialised = JSON.stringify(store.decisions);
  assert.equal(serialised.includes("dentist"), false, "a personal detail in the calibration log");
  assert.match(store.decisions[0].context_hash, /^[0-9a-f]{32}$/);
});

test("existing content is shown to the model, because duplicate is a different question", async () => {
  const provider = fakeProvider();
  const { gate } = gateWith({ provider });

  await gate.evaluate({ content: "new text", existing: "something already stored" });

  const state = provider.calls[0].body.state;
  assert.match(state, /ALREADY STORED/);
  assert.match(state, /new text/);
});

test("tags and source reach the state, because they change the answer", async () => {
  const provider = fakeProvider();
  const { gate } = gateWith({ provider });

  await gate.evaluate({ content: "x", item: { tags: ["preference"], source: "chat" } });

  const state = provider.calls[0].body.state;
  assert.match(state, /TAGS: preference/);
  assert.match(state, /SOURCE: chat/);
});

test("the surrounding conversation is deliberately not sent", async () => {
  const provider = fakeProvider();
  const { gate } = gateWith({ provider });

  await gate.evaluate({ content: "x", item: { history: "a long conversation the model must not see" } });

  assert.equal(
    provider.calls[0].body.state.includes("long conversation"),
    false,
    "the model judges one memory, not the session around it"
  );
});

test("the threshold comes from config, and is reported on the row", async () => {
  // A log of noul scores with no threshold cannot be thresholded afterwards.
  const custom = { ...config, thresholds: { ...config.thresholds, writeGate: 0.42 } };
  const { gate, store } = gateWith({ provider: fakeProvider({ answers: { worth_storing: { type: NOUL, noul: 0.5 } } }), config: custom });

  const result = await gate.evaluate({ content: "x" });

  assert.equal(result.threshold, 0.42, "read from config, not hardcoded");
  assert.equal(result.outcome, OUTCOME.STORE, "0.5 is above 0.42");
  assert.equal(store.decisions[0].threshold_used, 0.42);
});

test("the outcome is left null for calibration to fill in later", async () => {
  const { gate, store } = gateWith({ provider: fakeProvider() });
  await gate.evaluate({ content: "x" });

  // A row that already knows its own outcome is a row calibration cannot learn
  // from. The label comes from review.
  assert.equal(store.decisions[0].outcome, null);
  assert.ok(store.decisions[0].was_applied, "and a proposal still counts as a recorded decision");
});

test("the question is a noul with instructions, not a prompt", async () => {
  const { gate } = gateWith({ provider: fakeProvider() });

  // A decision model does not generate prose and cannot be asked to. The
  // question has to be typed and have instructions, or it is not a decision.
  assert.equal(gate.question.type, NOUL);
  assert.equal(gate.question.key, "worth_storing");
  assert.ok(gate.question.instructions.length > 40, "and the instructions are the actual question");

  // It is a single call, not a conversation.
  const provider = fakeProvider();
  const single = gateWith({ provider });
  await single.gate.evaluate({ content: "x" });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Object.keys(provider.calls[0].body.questions), ["worth_storing"]);
});
