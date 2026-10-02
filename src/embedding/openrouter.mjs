/**
 * The OpenRouter embedding client.
 *
 * One key, one base URL, one model id — the whole provider surface. There is
 * no local inference anywhere behind this (ADR-009), and the absence is
 * structural rather than aspirational: this file makes an HTTP call or it does
 * not embed.
 *
 * What it is responsible for beyond the request:
 *
 *   - Batching, because one request per item is one round trip per item.
 *   - Caching, because embeddings are deterministic and re-embedding the same
 *     text on every search is paying again for an answer already stored.
 *   - Retrying only what is worth retrying. A 429 is worth it; a 401 is not,
 *     and retrying a 401 three times turns a configuration mistake into a
 *     timeout.
 *   - Refusing to return a vector whose width disagrees with the column. This
 *     is the one that matters most, and it is a hard error rather than a
 *     warning: two models' vectors in one index are meaningless, and the
 *     failure mode of noticing late is a search that returns nonsense with
 *     plausible-looking numbers.
 */

import { createHash } from "node:crypto";

/** Status codes worth retrying. Everything else fails immediately. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524, 529]);

/**
 * Why these and not others.
 *
 * 429 is a rate limit and 529 is provider-overloaded: both are "not now", and
 * both pass. 5xx are the gateway failing before or after the provider, and
 * are usually transient. 401 (bad key), 402 (no credit), 403 (permissions),
 * 404 (no such model) and 400 (malformed) are all "not ever" — a retry spends
 * the caller's time and gets the same answer.
 */
export function isRetryableStatus(status) {
  return RETRYABLE.has(status);
}

export function createEmbedder({
  config,
  logger = null,
  store = null,
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep
}) {
  const baseUrl = config.providers.baseUrl.replace(/\/+$/, "");
  const model = config.providers.embedModel;
  const expectedDimensions = config.embedding.dimensions;
  const timeoutMs = config.providers.requestTimeoutMs;

  /**
   * Cache key: the text's own hash.
   *
   * Content-addressed rather than a caller-supplied key, because a
   * caller-supplied key is a correctness hazard: two callers passing the same
   * string "default" for different text get the same vector. The hash cannot
   * collide in practice and needs no coordination.
   *
   * The model is part of the primary key, not the hash, so a model migration
   * leaves both sets of vectors intact and comparable. That is the property
   * that makes `memory_embeddings` safe to keep (ADR-005).
   */
  function cacheKeyFor(text) {
    return hashText(text);
  }

  /**
   * Embed a list of strings, batched and cached.
   *
   * Returns vectors in the same order as the input, always, including for a
   * cache hit. A caller that assumes index alignment between a query and its
   * candidate list gets a subtly wrong ranking rather than an error if that
   * ever slips, so the ordering is a promise of this function rather than an
   * accident of the batching.
   */
  async function embed(texts, { model: override = null, inputType = null, useCache = true } = {}) {
    if (!Array.isArray(texts)) {
      throw new TypeError(`embed() expects an array of strings, got ${typeof texts}`);
    }
    if (texts.length === 0) return [];

    const activeModel = override ?? model;
    const clean = texts.map((text) => {
      if (typeof text !== "string") {
        throw new TypeError(`embed() expects strings, found ${typeof text}`);
      }
      return text;
    });

    // An empty string embeds, but it embeds to a vector that matches nothing
    // in particular and is almost always a bug at the call site — an empty
    // query, a node with no summary. Failing here names the input; failing
    // later produces a search that quietly finds nothing.
    for (const [index, text] of clean.entries()) {
      if (text.trim() === "") {
        throw new RangeError(
          `embed() refused an empty string at index ${index}. An empty ` +
            `embedding matches nothing in particular and is nearly always a ` +
            `caller that meant to skip this input.`
        );
      }
    }

    const results = new Array(clean.length);
    const toEmbed = [];

    for (const [index, text] of clean.entries()) {
      if (!useCache || !store) {
        toEmbed.push({ index, text });
        continue;
      }
      const cached = await lookup(text, activeModel);
      if (cached) {
        results[index] = cached;
      } else {
        toEmbed.push({ index, text });
      }
    }

    // Deduplicate within the request. A search that re-runs the same query
    // twice, or a batch with repeated node summaries, should not pay twice
    // for the same vector.
    const byText = new Map();
    for (const entry of toEmbed) {
      if (!byText.has(entry.text)) byText.set(entry.text, []);
      byText.get(entry.text).push(entry.index);
    }

    const unique = [...byText.keys()];
    const batchSize = config.embedding.batchSize;
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const batch = unique.slice(offset, offset + batchSize);
      const vectors = await embedBatch(batch, activeModel, inputType);
      for (const [i, text] of batch.entries()) {
        for (const index of byText.get(text)) results[index] = vectors[i];
        // Written after the batch succeeds, not per item. A batch that fails
        // halfway through must not leave half of its inputs cached, or the
        // retry pays again for the ones that already succeeded.
        if (useCache && store) await save(text, activeModel, vectors[i]);
      }
    }

    // Every slot filled, or the function throws above. A sparse array here
    // would be an undefined vector reaching pgvector, which becomes a
    // malformed literal rather than an error.
    for (const [index, vector] of results.entries()) {
      if (!vector) {
        throw new Error(`embed() left index ${index} unfilled — a batching bug, not a provider error`);
      }
    }

    return results;
  }

  /** One HTTP call for up to `batchSize` texts. */
  async function embedBatch(texts, activeModel, inputType) {
    const body = {
      model: activeModel,
      input: texts,
      // Explicit rather than relying on the default. The default is currently
      // float, and a base64 response decoded as a float array produces
      // garbage of the right length — which is exactly the kind of failure
      // that never surfaces as an error.
      encoding_format: "float"
    };

    // `input_type` is a per-request field, not per-input, so a batch mixing
    // queries and passages cannot be sent. Refusing beats sending a single
    // type for all of them, which produces query embeddings for documents and
    // quietly degrades every hit.
    if (inputType) body.input_type = inputType;

    const response = await postJson(`${baseUrl}/embeddings`, body, { retries: 3 });
    const payload = await parseJson(response, body.model);

    const data = payload?.data;
    if (!Array.isArray(data)) {
      throw new Error(
        `Embedding response from ${body.model} has no data array. Got: ` +
          `${describeShape(payload)}. A proxy returning HTML with a 200 is the ` +
          `usual cause.`
      );
    }
    if (data.length !== texts.length) {
      throw new Error(
        `Embedding response from ${body.model} returned ${data.length} vectors ` +
          `for ${texts.length} inputs. Refusing to guess which input each belongs to.`
      );
    }

    const vectors = data.map((entry, index) => decodeVector(entry, index, body.model));

    for (const [index, vector] of vectors.entries()) {
      assertDimensions(vector, texts[index], body.model);
    }

    return vectors;
  }

  /**
   * Read a vector out of one response entry.
   *
   * `encoding_format: "base64"` returns the vector as a string. The client
   * asked for float, so a string here means a provider ignored the request —
   * and decoding it as a float array would produce plausible numbers of the
   * wrong length.
   */
  function decodeVector(entry, index, activeModel) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Embedding response entry ${index} from ${activeModel} is not an object`);
    }
    const vector = entry.embedding;
    if (typeof vector === "string") {
      throw new Error(
        `Embedding response entry ${index} from ${activeModel} is a string. The ` +
          `client requested encoding_format "float"; a provider returned base64. ` +
          `Decoding it as numbers would give a vector of the wrong length.`
      );
    }
    if (!Array.isArray(vector)) {
      throw new Error(
        `Embedding response entry ${index} from ${activeModel} has no embedding array`
      );
    }
    return vector.map(Number);
  }

  /**
   * The width check.
   *
   * This is the one place where a wrong number becomes a wrong answer rather
   * than an error. A vector of a different width is rejected here, loudly,
   * with both numbers in the message — because "different vector dimensions
   * 3072 and 1536" arriving from pgvector three layers away is a much worse
   * report than being told which text and which model produced it.
   */
  function assertDimensions(vector, text, activeModel) {
    if (vector.length === expectedDimensions) return;

    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    throw new Error(
      `Embedding from ${activeModel} has ${vector.length} dimensions, the ` +
        `column expects ${expectedDimensions}. Refusing to store it.\n` +
        `  text: ${preview}\n` +
        `  Two models' vectors must never share one index (ADR-005). Either the ` +
        `configured model changed, or the provider changed its output width, and ` +
        `both mean a re-embed rather than a config edit.`
    );
  }

  async function lookup(text, activeModel) {
    try {
      const row = await store.getCachedEmbedding(cacheKeyFor(text), activeModel);
      if (!row) return null;

      // A cache row written by a different width of the same model id is the
      // exact hazard this check exists for. Cheap, and it catches a provider
      // that silently changed.
      if (row.dimensions !== null && Number(row.dimensions) !== expectedDimensions) {
        return null;
      }

      const vector = typeof row.vector === "string" ? JSON.parse(row.vector) : row.vector;
      return Array.isArray(vector) && vector.length === expectedDimensions ? vector.map(Number) : null;
    } catch (err) {
      // A cache read failure must not fail the embed. The fallback is a paid
      // API call, which is worse than slow and never worse than broken.
      logger?.warn("embedding cache read failed", { message: err.message });
      return null;
    }
  }

  async function save(text, activeModel, vector) {
    if (!store) return;
    try {
      await store.upsertCachedEmbedding(cacheKeyFor(text), activeModel, vector, expectedDimensions);
    } catch (err) {
      // Same reasoning as the read: paying twice is recoverable, failing the
      // write path is not.
      logger?.warn("embedding cache write failed", { message: err.message });
    }
  }

  /**
   * POST with bounded retries.
   *
   * Retryable statuses are retried with exponential backoff and jitter.
   * Non-retryable ones are not, and the distinction is the point: retrying a
   * 401 three times turns "your key is wrong" into a 30-second hang followed
   * by the same message.
   *
   * Jitter is not decoration. Without it, a batch of concurrent searches that
   * all hit a rate limit retries in lockstep and reproduces the rate limit.
   */
  async function postJson(url, body, { retries = 3 } = {}) {
    if (!config.providers.apiKey) {
      throw new Error(
        "No OpenRouter API key. Set OPENROUTER_API_KEY. The embedder cannot " +
          "fall back to a local model — there is none, by ADR-009."
      );
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        // 500ms, 1s, 2s, plus up to 250ms of jitter.
        const backoff = 500 * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * 250);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            // No logging of this object. The header holds the key, and the
            // logger's redaction list would catch `authorization` as a key
            // name but the value is a bare string with no label on it.
            authorization: `Bearer ${config.providers.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        lastError = err;
        // An abort is a timeout, which is retryable. Anything else at the
        // network layer is treated the same way: DNS blips and connection
        // resets are worth one more try.
        if (attempt < retries) continue;
        throw new Error(
          `Embedding request failed after ${attempt + 1} attempts: ${err.message}` +
            (err.name === "AbortError" ? ` (timed out after ${timeoutMs}ms)` : "")
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return response;

      const detail = await errorDetail(response);

      if (!isRetryableStatus(response.status) || attempt === retries) {
        throw new EmbeddingRequestError(response.status, detail, body.model, attempt + 1);
      }

      lastError = new Error(`${response.status}: ${detail}`);
      logger?.warn("embedding request retrying", {
        status: response.status,
        attempt: attempt + 1,
        model: body.model
      });
    }

    throw lastError ?? new Error("Embedding request failed for an unstated reason");
  }

  /**
   * Build a failure message from a response body.
   *
   * Only the message, and only after confirming it is a string. A 502 from a
   * proxy is often HTML, and putting a page of markup in an error message
   * turns a one-line failure into a screenful.
   */
  async function errorDetail(response) {
    try {
      const text = await response.text();
      if (!text) return response.statusText || "no body";

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return truncate(text, 200);
      }
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      return typeof message === "string" ? truncate(message, 300) : truncate(JSON.stringify(parsed), 200);
    } catch {
      return response.statusText || "unreadable body";
    }
  }

  /**
   * The multimodal path.
   *
   * `google/gemini-embedding-2` puts text and images in one space, so a query
   * that is an image and an item that is text are comparable without a second
   * index (ADR-005). This is the function that makes that true, and it is the
   * reason the modality is not a separate subsystem.
   */
  async function embedContent(content, { model: override = null, inputType = null } = {}) {
    const activeModel = override ?? model;
    const body = {
      model: activeModel,
      input: [content],
      encoding_format: "float"
    };
    if (inputType) body.input_type = inputType;

    const response = await postJson(`${baseUrl}/embeddings`, body, { retries: 3 });
    const payload = await parseJson(response, body.model);
    const data = payload?.data;
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error(
        `Multimodal embedding from ${body.model} returned ${data?.length ?? 0} vectors, expected 1`
      );
    }
    const vector = decodeVector(data[0], 0, body.model);
    assertDimensions(vector, describeContent(content), body.model);
    return vector;
  }

  /**
   * What to send as `input`.
   *
   * A bare string stays a bare string rather than being wrapped in
   * `[{content: [{type: "text", text}]}]`. Both are accepted by the API, and
   * the wrapped form is what a multimodal model needs — but sending it for
   * text-only is a shape the text-only path never sees, so the two are kept
   * distinct and only the multimodal one builds content parts.
   */
  function textInput(text) {
    return text;
  }

  function contentInput(parts) {
    return { content: parts };
  }

  return {
    model,
    dimensions: expectedDimensions,
    batchSize: config.embedding.batchSize,
    embed,
    embedBatch: (texts, opts) => embedBatch(texts, opts?.model ?? model, opts?.inputType ?? null),
    embedContent,
    textInput,
    contentInput,
    /** Whether this client can work at all. Never triggers a request. */
    available: () => Boolean(config.providers.apiKey),
    /** A stable identifier for the (model, width) pair this client produces. */
    identity: () => `${model}@${expectedDimensions}`,
    cacheKeyFor
  };
}

/** A failure with the status attached, so callers can branch on it. */
export class EmbeddingRequestError extends Error {
  constructor(status, detail, model, attempts) {
    super(
      `Embedding request to ${model} failed with ${status} after ${attempts} attempt(s): ${detail}` +
        (status === 401 ? " — the API key is missing, wrong, or expired." : "") +
        (status === 402 ? " — the OpenRouter account has no credit." : "") +
        (status === 404 ? ` — the model does not exist or is not an embedding model.` : "")
    );
    this.name = "EmbeddingRequestError";
    this.status = status;
    this.model = model;
    this.attempts = attempts;
    this.retryable = isRetryableStatus(status);
  }
}

async function parseJson(response, model) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Embedding response from ${model} is not JSON: ${truncate(text, 200)}. ` +
        `A 200 with an HTML body usually means a proxy is intercepting the request.`
    );
  }
}

/**
 * Cache key for a text.
 *
 * sha256, truncated to 32 hex characters, stated once here so it cannot drift
 * between the writer and anything that recomputes a key. It is not a security
 * hash — it identifies content so a repeat is recognisable, and a collision
 * would have to be constructed deliberately.
 */
function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max) {
  const clean = String(text);
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/** A short, non-reversible description of a content block, for error text. */
function describeContent(content) {
  const parts = content?.content;
  if (!Array.isArray(parts)) return "content";
  return parts
    .map((part) => (part.type === "text" ? `text:${truncate(part.text, 40)}` : part.type))
    .join("+");
}
