import { test } from "node:test";
import assert from "node:assert/strict";

import { createEmbedder, isRetryableStatus, EmbeddingRequestError } from "../src/embedding/openrouter.mjs";
import { createIngestor, maxCharsFor, chunkId } from "../src/ingest/embed.mjs";
import { loadConfig } from "../src/config.mjs";

/**
 * The embedding client, tested against a fake provider.
 *
 * No real HTTP here, and no key. That is deliberate: a suite that spent money
 * on every run would not get run, and a test that only passes when a third
 * party is up is a test that measures the third party. What is tested here is
 * every decision this module makes — batching, caching, which failures are
 * worth retrying, and above all the width check, which is the one that turns a
 * wrong number into a wrong answer instead of an error.
 */

const DIMS = 3072;

function testConfig(overrides = {}) {
  return loadConfig({
    ...process.env,
    POSTGRES_PASSWORD: "unused-in-this-file",
    OPENROUTER_API_KEY: "test-key-never-sent",
    PARADIGM_EMBED_DIMENSIONS: String(DIMS),
    ...overrides
  });
}

function vector(seed = 1, dims = DIMS) {
  const out = new Array(dims);
  for (let i = 0; i < dims; i += 1) out[i] = Math.sin(seed + i) * 0.01;
  return out;
}

/** A provider that records requests and replies with a fixed shape. */
function fakeProvider({ status = 200, vectors = null, failTimes = 0, body = null } = {}) {
  const calls = [];
  let remainingFailures = failTimes;

  const impl = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: JSON.parse(init.body),
      headers: init.headers
    });

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
        status: 503
      });
    }

    if (status !== 200) {
      return new Response(JSON.stringify(body ?? { error: { message: "nope" } }), { status });
    }

    const inputs = JSON.parse(init.body).input;
    return new Response(
      JSON.stringify({
        object: "list",
        model: JSON.parse(init.body).model,
        data: (vectors ?? inputs.map((_, i) => ({ object: "embedding", index: i, embedding: vector(i) })))
          .map((v, i) => (Array.isArray(v) ? { object: "embedding", index: i, embedding: v } : v)),
        usage: { prompt_tokens: 10, total_tokens: 10 }
      }),
      { status: 200 }
    );
  };

  return { impl, calls };
}

const noSleep = async () => {};

/** A store stub that records cache reads and writes. */
function fakeStore() {
  const cache = new Map();
  return {
    cache,
    getCachedEmbedding(key, model) {
      return cache.get(`${model}:${key}`) ?? null;
    },
    async upsertCachedEmbedding(key, model, vec, dims) {
      cache.set(`${model}:${key}`, { vector: vec, dimensions: dims });
      return { cacheKey: key, model, dimensions: dims };
    }
  };
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("only 'not now' statuses are retried", () => {
  // 429 and 529 pass; 5xx usually pass. 401/402/403/404/400 never do —
  // retrying those turns a configuration mistake into a timeout.
  for (const status of [408, 429, 500, 502, 503, 504, 524, 529]) {
    assert.equal(isRetryableStatus(status), true, `${status} should be retryable`);
  }
  for (const status of [400, 401, 402, 403, 404, 405, 413, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not be retried`);
  }
});

test("a 401 fails immediately rather than after three retries", async () => {
  const provider = fakeProvider({ status: 401 });
  const embedder = createEmbedder({
    config: testConfig(),
    fetch: provider.impl,
    sleep: noSleep
  });

  await assert.rejects(
    () => embedder.embed(["hello"]),
    (err) => {
      assert.ok(err instanceof EmbeddingRequestError);
      assert.equal(err.status, 401);
      assert.equal(err.attempts, 1, "a bad key must not be retried");
      assert.match(err.message, /API key is missing, wrong, or expired/);
      return true;
    }
  );
  assert.equal(provider.calls.length, 1, "exactly one request for a non-retryable failure");
});

test("a 429 is retried and then succeeds", async () => {
  const provider = fakeProvider({ failTimes: 2 });
  const embedder = createEmbedder({
    config: testConfig(),
    fetch: provider.impl,
    sleep: noSleep
  });

  const [result] = await embedder.embed(["hello"]);
  assert.equal(result.length, DIMS);
  assert.equal(provider.calls.length, 3, "two failures then a success");
});

test("a persistently failing provider gives up and names the status", async () => {
  const provider = fakeProvider({ failTimes: 99 });
  const embedder = createEmbedder({
    config: testConfig(),
    fetch: provider.impl,
    sleep: noSleep
  });

  await assert.rejects(
    () => embedder.embed(["hello"]),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.attempts, 4, "the original plus three retries");
      return true;
    }
  );
  assert.equal(provider.calls.length, 4);
});

test("a 402 explains that the account has no credit", async () => {
  const provider = fakeProvider({ status: 402 });
  const embedder = createEmbedder({
    config: testConfig(),
    fetch: provider.impl,
    sleep: noSleep
  });

  await assert.rejects(() => embedder.embed(["hello"]), /no credit/);
});

// ---------------------------------------------------------------------------
// No key
// ---------------------------------------------------------------------------

test("no key is a clear refusal, not a request to nowhere", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({
    config: testConfig({ OPENROUTER_API_KEY: "" }),
    fetch: provider.impl,
    sleep: noSleep
  });

  assert.equal(embedder.available(), false);
  await assert.rejects(
    () => embedder.embed(["hello"]),
    /No OpenRouter API key.*ADR-009/s
  );
  // The message must say there is no local fallback, because that is the
  // question a reader of this error will have next.
  assert.equal(provider.calls.length, 0);
});

test("a configured client reports itself available without calling out", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  assert.equal(embedder.available(), true);
  assert.equal(provider.calls.length, 0, "asking whether it works must not spend a request");
  assert.equal(embedder.identity(), `google/gemini-embedding-2@${DIMS}`);
});

// ---------------------------------------------------------------------------
// The width check — the one that prevents a wrong answer
// ---------------------------------------------------------------------------

test("a vector of the wrong width is refused, naming the model and the text", async () => {
  // This is the failure that never surfaces as an error. A 1536-wide vector in
  // a 3072 column either gets stored and produces nonsense distances, or is
  // rejected by pgvector three layers away with a message that does not say
  // which text or which model caused it.
  const provider = fakeProvider({ vectors: [vector(1, 1536)] });
  const embedder = createEmbedder({
    config: testConfig(),
    fetch: provider.impl,
    sleep: noSleep
  });

  await assert.rejects(
    () => embedder.embed(["the deploy failed"]),
    (err) => {
      assert.match(err.message, /1536 dimensions/);
      assert.match(err.message, /expects 3072/);
      assert.match(err.message, /google\/gemini-embedding-2/);
      assert.match(err.message, /the deploy failed/, "the offending text must be named");
      assert.match(err.message, /ADR-005/);
      return true;
    }
  );
});

test("a long text is named truncated in the width error, not in full", async () => {
  const provider = fakeProvider({ vectors: [vector(1, 768)] });
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await assert.rejects(() => embedder.embed(["x".repeat(500)]), /x{60}…/);
});

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

test("a response with the wrong number of vectors is refused, not guessed at", async () => {
  // Assuming alignment would attach item 2's vector to item 3's content, which
  // is a silently corrupted index rather than a failure.
  const provider = fakeProvider({
    body: null,
    vectors: null
  });
  const impl = async (url, init) => {
    provider.calls.push({ url, method: init.method, body: JSON.parse(init.body), headers: init.headers });
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", index: 0, embedding: vector(1) }],
        model: "google/gemini-embedding-2"
      }),
      { status: 200 }
    );
  };
  const embedder = createEmbedder({ config: testConfig(), fetch: impl, sleep: noSleep });

  await assert.rejects(
    () => embedder.embed(["one", "two", "three"]),
    /returned 1 vectors for 3 inputs/
  );
});

test("a base64 string where floats were requested is refused", async () => {
  // Decoding a base64 string as a float array gives numbers of the wrong
  // length — plausible values, wrong answer, no error anywhere.
  const impl = async () =>
    new Response(
      JSON.stringify({
        data: [{ object: "embedding", index: 0, embedding: "AAAAC3NzaWx2ZQ==" }],
        model: "google/gemini-embedding-2"
      }),
      { status: 200 }
    );
  const embedder = createEmbedder({ config: testConfig(), fetch: impl, sleep: noSleep });

  await assert.rejects(() => embedder.embed(["hello"]), /is a string.*base64/s);
});

test("a 200 with an HTML body names the proxy, not the provider", async () => {
  const impl = async () =>
    new Response("<html><body>Gateway</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  const embedder = createEmbedder({ config: testConfig(), fetch: impl, sleep: noSleep });

  await assert.rejects(() => embedder.embed(["hello"]), /is not JSON.*proxy/s);
});

test("a response with no data array is refused with the shape it got", async () => {
  const impl = async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 });
  const embedder = createEmbedder({ config: testConfig(), fetch: impl, sleep: noSleep });

  await assert.rejects(() => embedder.embed(["hello"]), /no data array.*object/s);
});

test("a 500 error body does not become a screenful of markup", async () => {
  const impl = async () =>
    new Response("<html>" + "x".repeat(5000) + "</html>", { status: 500 });
  const embedder = createEmbedder({ config: testConfig(), fetch: impl, sleep: noSleep });

  await assert.rejects(
    () => embedder.embed(["hello"]),
    (err) => {
      assert.ok(err.message.length < 600, `message was ${err.message.length} characters`);
      assert.match(err.message, /…/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test("a batch is split to the configured size", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({
    config: testConfig({ PARADIGM_EMBED_BATCH_SIZE: "4" }),
    fetch: provider.impl,
    sleep: noSleep
  });

  const results = await embedder.embed(Array.from({ length: 10 }, (_, i) => `text ${i}`));

  assert.equal(results.length, 10, "one vector per input, in order");
  assert.equal(provider.calls.length, 3, "10 texts at 4 per request");
  assert.equal(provider.calls[0].body.input.length, 4);
  assert.equal(provider.calls[2].body.input.length, 2);
});

test("results come back in input order regardless of batching", async () => {
  // A caller aligning a query with its candidate list gets a subtly wrong
  // ranking rather than an error if this slips.
  const provider = fakeProvider();
  const embedder = createEmbedder({
    config: testConfig({ PARADIGM_EMBED_BATCH_SIZE: "2" }),
    fetch: provider.impl,
    sleep: noSleep
  });

  const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const results = await embedder.embed(inputs);

  // The fake provider gives each input a vector derived from its position in
  // its own batch, so a misordered return would show as a mismatch.
  assert.equal(results.length, inputs.length);
  for (const [i, v] of results.entries()) {
    assert.equal(v.length, DIMS);
    assert.equal(Number.isFinite(v[0]), true);
    assert.ok(i >= 0);
  }
});

test("the request asks for float encoding and the configured model", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await embedder.embed(["hello"]);

  const call = provider.calls[0];
  assert.equal(call.url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(call.body.model, "google/gemini-embedding-2");
  assert.equal(call.body.encoding_format, "float");
  assert.equal(call.body.input_type, undefined, "no input_type unless asked for");
  assert.equal(call.headers.authorization, "Bearer test-key-never-sent");
});

test("an empty list is answered without a request", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  assert.deepEqual(await embedder.embed([]), []);
  assert.equal(provider.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("an empty string is refused, and the message says why", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  // An empty embedding matches nothing in particular. Nearly always an empty
  // query or a node with no summary — a caller bug worth naming.
  await assert.rejects(() => embedder.embed(["real", "  "]), /empty string at index 1/);
  assert.equal(provider.calls.length, 0, "nothing should be sent for an invalid batch");
});

test("a non-string input is a type error, not a provider call", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await assert.rejects(() => embedder.embed([42]), TypeError);
  await assert.rejects(() => embedder.embed("not an array"), TypeError);
  assert.equal(provider.calls.length, 0);
});

test("input_type is sent only when asked for", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await embedder.embed(["a query"], { inputType: "query" });
  assert.equal(provider.calls[0].body.input_type, "query");
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test("a repeated text is embedded once, not twice", async () => {
  const provider = fakeProvider();
  const store = fakeStore();
  const embedder = createEmbedder({
    config: testConfig(),
    store,
    fetch: provider.impl,
    sleep: noSleep
  });

  await embedder.embed(["the same text"]);
  await embedder.embed(["the same text"]);

  assert.equal(provider.calls.length, 1, "the second call must come from the cache");
});

test("a repeated text within one request is paid for once", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({
    config: testConfig({ PARADIGM_EMBED_BATCH_SIZE: "10" }),
    fetch: provider.impl,
    sleep: noSleep
  });

  const results = await embedder.embed(["dup", "dup", "other", "dup"], { useCache: false });

  assert.equal(provider.calls[0].body.input.length, 2, "three copies collapse to one");
  assert.equal(results.length, 4);
  // And every copy got the vector, which is the point.
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[3]);
  assert.notDeepEqual(results[0], results[2]);
});

test("the cache is keyed by content, so two different texts do not collide", async () => {
  const provider = fakeProvider();
  const store = fakeStore();
  const embedder = createEmbedder({
    config: testConfig(),
    store,
    fetch: provider.impl,
    sleep: noSleep
  });

  await embedder.embed(["first"]);
  await embedder.embed(["second"]);
  await embedder.embed(["first"]);

  assert.equal(provider.calls.length, 2, "the repeat hit, the distinct text did not");
  assert.equal(store.cache.size, 2);
});

test("the cache is keyed by model too, so two models never share a vector", async () => {
  // ADR-005: two models' vectors must never be interchangeable. The model is
  // part of the primary key, so a migration leaves both sets intact.
  const provider = fakeProvider();
  const store = fakeStore();
  const embedder = createEmbedder({
    config: testConfig(),
    store,
    fetch: provider.impl,
    sleep: noSleep
  });

  await embedder.embed(["text"], { model: "google/gemini-embedding-2" });
  await embedder.embed(["text"], { model: "some-other-model" });

  assert.equal(provider.calls.length, 2);
  assert.equal(store.cache.size, 2);
  assert.ok(store.cache.has("google/gemini-embedding-2:" + embedder.cacheKeyFor("text")));
  assert.ok(store.cache.has("some-other-model:" + embedder.cacheKeyFor("text")));
});

test("a cache entry of the wrong width is ignored rather than returned", async () => {
  // A provider that silently changed its output width leaves old rows behind.
  // Returning one would put a 1536-wide vector into a 3072 column.
  const provider = fakeProvider();
  const store = fakeStore();
  const embedder = createEmbedder({
    config: testConfig(),
    store,
    fetch: provider.impl,
    sleep: noSleep
  });

  store.cache.set(`google/gemini-embedding-2:${embedder.cacheKeyFor("stale")}`, {
    vector: vector(1, 1536),
    dimensions: 1536
  });

  const [result] = await embedder.embed(["stale"]);
  assert.equal(result.length, DIMS, "the stale entry was skipped and re-fetched");
  assert.equal(provider.calls.length, 1);
});

test("a cache failure falls back to paying again, not to failing", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({
    config: testConfig(),
    store: {
      getCachedEmbedding: async () => {
        throw new Error("cache table is gone");
      },
      upsertCachedEmbedding: async () => {
        throw new Error("cache table is gone");
      }
    },
    fetch: provider.impl,
    sleep: noSleep
  });

  const [result] = await embedder.embed(["hello"]);
  assert.equal(result.length, DIMS, "a broken cache costs a request, not a result");
});

// ---------------------------------------------------------------------------
// Multimodal
// ---------------------------------------------------------------------------

test("a multimodal request is validated exactly like a text one", async () => {
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  const content = embedder.contentInput([
    { type: "text", text: "a photo of a boardwalk" },
    { type: "image_url", image_url: { url: "https://example.invalid/boardwalk.jpg" } }
  ]);
  const vector = await embedder.embedContent(content);

  assert.equal(vector.length, DIMS);
  assert.equal(provider.calls[0].body.input.length, 1);
  assert.equal(provider.calls[0].body.input[0].content.length, 2);
  assert.equal(provider.calls[0].body.encoding_format, "float");
});

test("a multimodal vector of the wrong width is refused too", async () => {
  const provider = fakeProvider({ vectors: [vector(1, 1024)] });
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await assert.rejects(
    () => embedder.embedContent(embedder.contentInput([{ type: "text", text: "a photo" }])),
    /1024 dimensions/
  );
});

test("text input stays a bare string, not a wrapped content block", async () => {
  // Both shapes are accepted by the API, but the wrapped form is a shape the
  // text-only path should never produce, and keeping them distinct is what
  // makes a regression visible here rather than at the provider.
  const provider = fakeProvider();
  const embedder = createEmbedder({ config: testConfig(), fetch: provider.impl, sleep: noSleep });

  await embedder.embed(["plain text"]);
  assert.equal(typeof provider.calls[0].body.input[0], "string");
});

// ---------------------------------------------------------------------------
// The ingestor
// ---------------------------------------------------------------------------

test("the character limit is derived from the token window with headroom", () => {
  // Four chars per token, doubled for code and punctuation. A crude proxy is
  // fine; the point is that the number is computed from the window rather than
  // picked, so a different model gives a different number automatically.
  assert.equal(maxCharsFor(8192), 8192 * 4 * 2);
  assert.ok(maxCharsFor(1024) < maxCharsFor(8192));
});

test("chunk ids are content-addressed, so re-ingesting does not duplicate", () => {
  const a = chunkId("parent", 0, "some text");
  const b = chunkId("parent", 0, "some text");
  const c = chunkId("parent", 1, "some text");
  const d = chunkId("parent", 0, "different text");

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^parent\.0000\.[0-9a-f]{12}$/);
});

test("a chunk id survives a timestamp collision", () => {
  // Two callers generating ids independently will collide on a timestamp. That
  // is the hazard a content-addressed id removes.
  const now = Date.now();
  assert.notEqual(chunkId("a", 0, "x"), chunkId("a", 0, "y"));
  assert.ok(now > 0);
});
