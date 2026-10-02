import { createHash } from "node:crypto";

/**
 * The decision client — System One, through OpenRouter.
 *
 * A decision model is not an LLM. It receives a `state` plus typed questions and
 * returns typed answers with calibrated probabilities. It does not generate
 * prose and cannot be asked to. That is the whole reason it is used for six
 * specific jobs instead of asking a cheap chat model to be careful.
 *
 * `POST /api/v1/systemone`
 *
 *   { model, state, questions: { key: { type: 'noul', instructions } } }
 *   -> { id, model, provider, answers: { key: { type, noul } }, usage }
 *
 * Three properties this module is built around, each of which has a way of
 * going wrong that is invisible in the response:
 *
 *   1. **A `noul` is a calibrated probability, not a score.** It belongs above
 *      a threshold and nowhere else. Comparing it against another model's
 *      `noul` is meaningless, and a threshold carried across a model change is
 *      a threshold for a different question.
 *   2. **Every call is recorded, not only the ones that changed behaviour.**
 *      A threshold can only be measured against what the system decided *not*
 *      to do. A log containing only applied decisions is a log that calibrates
 *      itself to agree with itself.
 *   3. **A failure is a skip, not a rejection.** A provider outage must not
 *      read as "this is not worth storing", because the two look identical from
 *      the caller's side and only one of them is a judgement.
 */

/** The System One endpoint. Not the chat one. */
const ENDPOINT_PATH = "/systemone";

/** Question types, as System One names them. */
export const NOUL = "noul";
export const CHOICE = "choice";

/** Statuses worth retrying. Same policy as the embedding client, and for the same reason. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524, 529]);

export function isRetryableStatus(status) {
  return RETRYABLE.has(status);
}

export class DecisionRequestError extends Error {
  constructor(status, detail, model, attempts) {
    super(
      `Decision request to ${model} failed with ${status} after ${attempts} attempt(s): ${detail}` +
        (status === 401 ? " — the API key is missing, wrong, or expired." : "") +
        (status === 402 ? " — the OpenRouter account has no credit." : "") +
        (status === 404 ? ` — ${model} is not available through the System One API.` : "")
    );
    this.name = "DecisionRequestError";
    this.status = status;
    this.model = model;
    this.attempts = attempts;
    this.retryable = isRetryableStatus(status);
  }
}

export function createDecisionClient({
  config,
  logger = null,
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep
}) {
  const baseUrl = config.providers.baseUrl.replace(/\/+$/, "");
  const model = config.providers.decisionModel;
  const timeoutMs = config.providers.requestTimeoutMs;

  /**
   * Ask the model.
   *
   * `state` is the thing being judged and `questions` are the typed questions
   * about it. More than one question in a single call is the point of the
   * model: the questions are answered against each other, so "is this worth
   * storing" and "is this the same entity as the one I have" are one
   * judgement rather than two independent guesses.
   *
   * @param {object} input
   * @param {string} input.state
   * @param {Record<string, object>} input.questions
   * @param {string} [input.model]
   * @param {string} [input.sessionId] groups related calls in provider logs
   * @returns {Promise<{answers, model, cost, latencyMs, id}>}
   */
  async function decide({ state, questions, model: override = null, sessionId = null }) {
    if (typeof state !== "string" || state.trim() === "") {
      throw new TypeError("decide() needs a state to judge");
    }
    if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) {
      throw new TypeError("decide() needs at least one question");
    }
    for (const [key, question] of Object.entries(questions)) {
      if (!question || typeof question.type !== "string") {
        throw new TypeError(`Question "${key}" needs a type (${NOUL} or ${CHOICE})`);
      }
      if (!question.instructions || String(question.instructions).trim() === "") {
        // An empty instruction produces a confident answer to a question
        // nobody asked, and it does not look wrong.
        throw new TypeError(`Question "${key}" needs instructions`);
      }
    }

    const activeModel = override ?? model;
    const started = Date.now();

    const body = {
      model: activeModel,
      state,
      questions
    };
    if (sessionId) body.session_id = String(sessionId).slice(0, 256);

    const response = await postJson(`${baseUrl}${ENDPOINT_PATH}`, body, { retries: 2 });
    const payload = await parseJson(response, activeModel);

    // The provider echoes back the model that actually served the request,
    // which may be a dated snapshot of the one asked for. Recorded verbatim: a
    // calibration number is only reproducible if the exact model id is known.
    const served = payload?.model ?? activeModel;
    const answers = parseAnswers(payload, activeModel);

    return {
      answers,
      model: served,
      requestedModel: activeModel,
      provider: payload?.provider ?? null,
      id: payload?.id ?? null,
      cost: Number(payload?.usage?.cost ?? 0) || 0,
      inputTokens: Number(payload?.usage?.input_tokens ?? 0) || 0,
      outputTokens: Number(payload?.usage?.output_tokens ?? 0) || 0,
      latencyMs: Date.now() - started
    };
  }

  /**
   * Read the answers, refusing anything unexpected.
   *
   * The failure being guarded against: a model that answers with a `choice`
   * where a `noul` was asked returns something truthy, and a caller that
   * treats a non-null answer as a score puts a category name into a probability
   * field. That surfaces much later as a threshold that behaves like a
   * boolean.
   */
  function parseAnswers(payload, activeModel) {
    const answers = payload?.answers;
    if (!answers || typeof answers !== "object") {
      throw new Error(
        `Decision response from ${activeModel} has no answers object. Got: ` +
          `${typeof answers}. A proxy returning HTML with a 200 is the usual cause.`
      );
    }

    const parsed = {};
    for (const [key, answer] of Object.entries(answers)) {
      if (!answer || typeof answer !== "object") {
        throw new Error(`Answer "${key}" from ${activeModel} is not an object`);
      }

      if (answer.type === NOUL) {
        const noul = Number(answer.noul);
        if (!Number.isFinite(noul)) {
          throw new Error(`Answer "${key}" from ${activeModel} has no numeric noul`);
        }
        // Out-of-range is a real possibility with a calibrated probability, and
        // clamping silently would hide a miscalibrated model. It is recorded
        // rather than corrected.
        parsed[key] = { type: NOUL, noul, inRange: noul >= 0 && noul <= 1 };
        continue;
      }

      if (answer.type === CHOICE) {
        const choice = answer.choice ?? answer.noul;
        parsed[key] = { type: CHOICE, choice: choice ?? null };
        continue;
      }

      // An unknown type is passed through rather than dropped: a new System One
      // question type should not crash a write path, and the type name is the
      // only clue about what happened.
      parsed[key] = { type: answer.type ?? "unknown", raw: answer };
    }
    return parsed;
  }

  async function postJson(url, body, { retries = 2 } = {}) {
    if (!config.providers.apiKey) {
      throw new Error(
        "No OpenRouter API key. The decision model cannot fall back to anything " +
          "local — there is no local model, by ADR-009 — and it does not fall " +
          "back to a chat model, because a chat model's 'sure, looks good' is " +
          "not a calibrated probability."
      );
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${config.providers.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) continue;
        throw new Error(
          `Decision request failed after ${attempt + 1} attempts: ${err.message}` +
            (err.name === "AbortError" ? ` (timed out after ${timeoutMs}ms)` : "")
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return response;

      const detail = await errorDetail(response);
      if (!isRetryableStatus(response.status) || attempt === retries) {
        throw new DecisionRequestError(response.status, detail, body.model, attempt + 1);
      }

      lastError = new Error(`${response.status}: ${detail}`);
      logger?.warn("decision request retrying", { status: response.status, attempt: attempt + 1 });
    }

    throw lastError ?? new Error("Decision request failed for an unstated reason");
  }

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

  return {
    model,
    decide,
    /** Whether this client can work. Never triggers a request. */
    available: () => Boolean(config.providers.apiKey),
    /**
     * A stable identifier for the (model, schema) pair.
     *
     * Includes the schema version because a `noul` from a different question
     * set is a different measurement even from the same model id.
     */
    identity: () => `${model}@systemone-v1`,
    build: {
      noul: (instructions) => ({ type: NOUL, instructions }),
      choice: (instructions, criteria) => ({ type: CHOICE, instructions, criteria })
    }
  };
}

/**
 * A hash of the state that was judged.
 *
 * Recorded on every decision row instead of the text. `decisions` is the
 * calibration substrate, it grows without bound, and a copy of every piece of
 * content that was ever considered for storage would turn it into the largest
 * unencrypted copy of the user's memory in the system. The hash is enough to
 * group repeats and to detect that a question was asked about the same thing
 * twice.
 */
export function contextHash(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 32);
}

async function parseJson(response, model) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Decision response from ${model} is not JSON: ${truncate(text, 200)}. ` +
        `A 200 with an HTML body usually means a proxy is intercepting the request.`
    );
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max) {
  const clean = String(text);
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
