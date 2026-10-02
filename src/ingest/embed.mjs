/**
 * Embedding for stored memories.
 *
 * The client knows how to talk to OpenRouter. This module knows *what* to
 * embed and what to do about the ones that fail, which is a different problem:
 *
 *   - An item is stored even if it cannot be embedded. A memory with no vector
 *     is still a memory, and blocking the write on a provider blip would lose
 *     the thing the user asked to remember.
 *   - Re-embedding is batched and rate-limited by this module, not by the
 *     caller, so no code path can accidentally fire one request per memory.
 *   - Every attempt is reported, including the ones that failed. A corpus that
 *     is 40% unembedded because the provider was down for an hour is a
 *     different system from one that is fully indexed, and the difference has
 *     to be visible.
 *
 * Nothing here is allowed to throw into a write path.
 */

import { createHash } from "node:crypto";

/** How many items to embed per batch of work, and how many batches in flight. */
const DEFAULT_BATCH = 32;
const DEFAULT_CONCURRENCY = 2;

/**
 * Text length guard.
 *
 * `google/gemini-embedding-2` has 8,192 tokens of input. A character count is
 * a crude proxy, so this is deliberately generous — about four characters per
 * token, then double it for the code and punctuation that tokenise badly.
 *
 * Over-long text is truncated rather than rejected. A memory too long for the
 * embedder should still be stored and searchable, and truncation degrades the
 * vector's quality on the tail while keeping retrieval working. Rejecting
 * would mean an unembedded memory, which is worse.
 */
const APPROX_CHARS_PER_TOKEN = 4;
const SAFETY_FACTOR = 2;
const MAX_INPUT_TOKENS = 8192;

export function maxCharsFor(contextTokens = MAX_INPUT_TOKENS) {
  return contextTokens * APPROX_CHARS_PER_TOKEN * SAFETY_FACTOR;
}

export function createIngestor({
  store,
  embedder,
  logger = null,
  batchSize = DEFAULT_BATCH,
  concurrency = DEFAULT_CONCURRENCY,
  contextTokens = MAX_INPUT_TOKENS
}) {
  const limit = maxCharsFor(contextTokens);

  /**
   * Embed one item and store the vector against it.
   *
   * Returns a result object rather than throwing. A caller writing a memory
   * needs to know the write succeeded and the embed did not — those are
   * separate facts and conflating them loses data.
   */
  async function embedItem(itemId, { text, model, truncate = true } = {}) {
    const content = text ?? (await store.readItem(itemId))?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { itemId, embedded: false, reason: "no text to embed" };
    }

    const payload = truncate && content.length > limit ? content.slice(0, limit) : content;
    const truncated = payload.length < content.length;

    try {
      const [vector] = await embedder.embed([payload], { model, useCache: true });
      await store.upsertItemVector(itemId, model ?? embedder.model, vector);
      return { itemId, embedded: true, dimensions: vector.length, truncated };
    } catch (err) {
      // The write already happened. Losing the memory because an embedding
      // failed would be the worse of the two failures by a wide margin.
      logger?.warn("item embedding failed", { itemId, message: err.message });
      return { itemId, embedded: false, reason: err.message, truncated };
    }
  }

  /**
   * Embed many items, reporting per item.
   *
   * Batching belongs to the client, not here. This module groups work so it
   * can bound concurrency and report progress; the client decides how many
   * texts go in one HTTP request. An earlier version of this function called
   * `embedItem` once per item, which meant its `batchSize` controlled how the
   * loop was chunked and nothing else — seven items at a batch size of two
   * still produced seven requests, and the parameter read as though it did
   * not.
   *
   * Concurrency is bounded because an unbounded `Promise.all` over a
   * re-embedding run is a self-inflicted rate limit: the first thing it
   * produces is a 429 for every request, and a re-embedding run that trips
   * the rate limit makes the backlog worse rather than better.
   */
  async function embedItems(items, { model, onProgress = null } = {}) {
    const queue = [...items];
    const results = [];
    let done = 0;

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      while (queue.length > 0) {
        const chunk = queue.splice(0, batchSize);
        results.push(...(await embedChunk(chunk, model)));

        for (const item of chunk) {
          done += 1;
          onProgress?.({ done, total: items.length, itemId: item.id });
        }
      }
    });

    await Promise.all(workers);

    const embedded = results.filter((r) => r.embedded);
    return {
      total: results.length,
      embedded: embedded.length,
      failed: results.length - embedded.length,
      // Named, not a count alone. 200 failures and 200 successes are the same
      // number and mean opposite things.
      failures: results.filter((r) => !r.embedded),
      results
    };
  }

  /**
   * Embed a group of items as one call to the client.
   *
   * The client batches internally, so this hands it the whole group and lets
   * it decide the request sizes. The per-item result is still produced here,
   * because a batch that fails partway is a per-item fact: three embedded and
   * four not is a different situation from a clean run, and the caller is
   * going to re-run on the unembedded ones.
   *
   * Nothing here throws. Every outcome is a result object, because the caller
   * is usually a write path that has already stored the memories and must not
   * be rolled back by an embedding failure.
   */
  async function embedChunk(chunk, model) {
    const outcome = [];
    const embeddable = [];

    for (const item of chunk) {
      const text = item.text;
      if (typeof text !== "string" || text.trim() === "") {
        outcome.push({ itemId: item.id, embedded: false, reason: "no text to embed" });
        continue;
      }
      embeddable.push({
        item,
        text: text.length > limit ? text.slice(0, limit) : text,
        truncated: text.length > limit
      });
    }

    if (embeddable.length === 0) return outcome;

    let vectors;
    try {
      vectors = await embedder.embed(
        embeddable.map((entry) => entry.text),
        { model }
      );
    } catch (err) {
      logger?.warn("embedding batch failed", {
        count: embeddable.length,
        message: err.message
      });
      for (const entry of embeddable) {
        outcome.push({ itemId: entry.item.id, embedded: false, reason: err.message, truncated: entry.truncated });
      }
      return outcome;
    }

    for (const [index, entry] of embeddable.entries()) {
      const vector = vectors[index];
      if (!vector) {
        outcome.push({
          itemId: entry.item.id,
          embedded: false,
          reason: "the client returned fewer vectors than inputs",
          truncated: entry.truncated
        });
        continue;
      }
      try {
        await store.upsertItemVector(entry.item.id, model ?? embedder.model, vector);
        outcome.push({
          itemId: entry.item.id,
          embedded: true,
          dimensions: vector.length,
          truncated: entry.truncated
        });
      } catch (err) {
        outcome.push({ itemId: entry.item.id, embedded: false, reason: err.message, truncated: entry.truncated });
      }
    }

    return outcome;
  }

  /**
   * Items that have no vector for the active model.
   *
   * The work list for a re-embed, and the thing that says whether an index is
   * complete. A memory system where a third of the corpus silently has no
   * vector retrieves a third of the time on three layers instead of four.
   */
  async function unembedded(options = {}) {
    return store.listUnembeddedItems({ ...options, model: options.model ?? embedder.model });
  }

  /**
   * How complete the index is.
   *
   * Reported by the health endpoint and by `/v1/workspaces`. A number rather
   * than a boolean, because "some unembedded" and "almost nothing embedded"
   * call for different responses.
   */
  async function coverage(options = {}) {
    return store.vectorCoverageSummary({ model: options.model ?? embedder.model });
  }

  return { embedItem, embedItems, unembedded, coverage, maxChars: limit };
}

/**
 * Stable id for a chunk, so re-ingesting the same text does not create a
 * second item.
 *
 * Content-addressed for the same reason the embedding cache key is: a
 * caller-supplied id is a correctness hazard, since two callers generating
 * ids independently will eventually collide on a timestamp and silently
 * overwrite one memory with another.
 */
export function chunkId(parentId, index, text) {
  const hash = createHash("sha256").update(`${parentId} ${index} ${text}`).digest("hex");
  return `${parentId}.${String(index).padStart(4, "0")}.${hash.slice(0, 12)}`;
}
