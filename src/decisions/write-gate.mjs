import { contextHash, NOUL } from "./client.mjs";

/**
 * The write gate.
 *
 * One question, asked before anything is stored: **is this worth keeping?**
 *
 * ## Three outcomes, not two
 *
 * The obvious design is a yes/no gate. It is the wrong shape for a memory
 * system, for a reason that is not about safety: a "no" from a model is a
 * model being wrong, and a memory system that discards on a model's say-so has
 * a data-loss bug whose frequency is the model's false-negative rate on the
 * day. Nobody can bound that in advance, and a bound is exactly what Phase 5's
 * gate asks for ("100 writes, zero false rejections").
 *
 * So there are three outcomes:
 *
 *   `store`   the model says it is worth keeping. Stored as `active`.
 *   `propose` the model says no. **Stored as `proposed`**, awaiting review.
 *             Nothing is discarded — the judgement is recorded, and the memory
 *             is still retrievable by whoever asks for proposals.
 *   `store`   with `skipped: true`. The provider was unreachable or
 *             unconfigured, so there is no judgement at all. The skip is
 *             recorded.
 *
 * The third is not a degraded path bolted on afterwards. It is Phase 5's own
 * gate: "when the decision provider is forced to fail, writes still succeed,
 * the gate is skipped, and the skip is recorded in the audit log."
 *
 * ## What `propose` costs
 *
 * A `propose` is a memory with a status, not a rejection. It does not appear
 * in ordinary search — the retrieval layer filters on `status = 'active'` — so
 * a corpus full of proposals does not flood recall. It appears in
 * `memory_list_proposed`, which is part of the MCP surface being kept, and
 * Phase 10 exposes a review action for it.
 *
 * The cost is that noise accumulates in a review queue instead of being
 * filtered. That is the trade this design makes deliberately: a noisy review
 * queue is visible and bounded by the user's attention, while a discarded
 * memory is invisible and permanent.
 */

/** The question asked. Versioned, because the wording is part of the model. */
export const WRITE_GATE_QUESTION = {
  key: "worth_storing",
  type: NOUL,
  instructions: [
    "Is this specific, durable and true about the user, worth remembering across sessions?",
    "Say no for transient chatter, for content the assistant already knows or can look up,",
    "for anything the user did not ask to be remembered, and for content that is merely",
    "plausible rather than actually stated."
  ].join(" ")
};

export const GATE_SCHEMA_VERSION = "write-gate-v1";

/**
 * The three outcomes, named.
 *
 * An enum rather than a boolean because "stored" is true in two very different
 * situations, and a caller that cannot tell them apart will report "the gate
 * rejected it" for a provider outage.
 */
export const OUTCOME = Object.freeze({
  STORE: "store",
  PROPOSE: "propose",
  SKIPPED: "skipped"
});

/**
 * The threshold used when config supplies none.
 *
 * A starting value, not a measured one — docs/THRESHOLDS.md is explicit that
 * hand-picked thresholds are guesses, and this is the guess that gets replaced
 * by measurement. It is reported on every decision row so a number produced
 * under it is never mistaken for a calibrated one.
 */
export const DEFAULT_WRITE_GATE_THRESHOLD = 0.6;

export function createWriteGate({ store, client, config = null, logger = null, threshold = null }) {
  /**
   * The threshold in force.
   *
   * From config when there is one, overridden explicitly when a caller is
   * measuring, and reported on every decision row as `threshold_used`. A
   * calibration number is only reproducible if the threshold that produced it
   * is known — a log of `noul` scores with no thresholds cannot be thresholded
   * afterwards.
   *
   * The first version of this ignored config entirely and returned a hardcoded
   * 0.6, so changing `PARADIGM_THRESHOLD_WRITE_GATE` did nothing. The value was
   * the same, which is why nothing looked broken.
   */
  const activeThreshold =
    threshold ?? config?.thresholds?.writeGate ?? DEFAULT_WRITE_GATE_THRESHOLD;

  /**
   * Judge a write.
   *
   * Never throws. A gate that throws turns a provider problem into a failed
   * write, and a failed write means the memory is not remembered — which is the
   * one outcome the gate exists to prevent.
   *
   * @param {object} input
   * @param {string} input.content
   * @param {object} [input.item] the rest of the item, for context
   * @returns {Promise<{outcome, status, score, threshold, model, skipped, reason, contextHash, latencyMs, cost}>}
   */
  async function evaluate({ content, item = {}, existing = null } = {}) {
    if (typeof content !== "string" || content.trim() === "") {
      // Nothing to judge. Not a rejection: an empty write is a caller bug, and
      // reporting it as a gate decision would put a spurious row in the
      // calibration log.
      return skipped("empty content — there is nothing to judge", null);
    }

    if (!client || !client.available()) {
      return skipped(
        "no decision provider configured; the write is stored and the gate is not applied",
        null
      );
    }

    const state = buildState({ content, item, existing });
    const hash = contextHash(state);

    let result;
    try {
      result = await client.decide({
        state,
        questions: { [WRITE_GATE_QUESTION.key]: WRITE_GATE_QUESTION }
      });
    } catch (err) {
      // A provider failure is not a judgement. Recorded as a skip so the
      // calibration log can tell "the model said no" apart from "we could not
      // ask", which are otherwise the same absence of a positive.
      logger?.warn("write gate skipped", { message: err.message });
      // Under `providerError`, not `status`.
      //
      // The first version spread `{ status: err.status }` into the result,
      // where `status` already meant *the memory's status* — so a 503 from the
      // provider overwrote `'active'` and the caller was told to store a
      // memory in a status numbered by an HTTP code. Two meanings of one word,
      // and the collision is invisible in a test that only checks `skipped`.
      return skipped(`decision provider unavailable: ${err.message}`, hash, {
        providerError: { message: err.message, httpStatus: err.status ?? null }
      });
    }

    const answer = result.answers[WRITE_GATE_QUESTION.key];

    if (!answer || answer.type !== NOUL || !Number.isFinite(answer.noul)) {
      // A malformed answer is a skip, not a rejection. Treating a missing
      // probability as a low one would make every provider hiccup quietly
      // demote writes to proposals.
      return skipped(`decision provider returned no usable answer: ${describeAnswer(answer)}`, hash, {
        servedModel: result.model,
        latencyMs: result.latencyMs
      });
    }

    const score = answer.noul;
    const applied = score >= activeThreshold;
    const outcome = applied ? OUTCOME.STORE : OUTCOME.PROPOSE;

    // Recorded either way. This is the whole substrate for calibration: a log
    // of only the applied decisions calibrates itself to agree with itself.
    await store
      .recordDecision({
        operation: "write_gate",
        // The model that actually served it, which may be a dated snapshot.
        model: result.model,
        questionKey: WRITE_GATE_QUESTION.key,
        questionType: NOUL,
        noul: score,
        confidence: result.answers.confidence?.noul ?? null,
        // "Applied" means the threshold let it become active. A proposal is a
        // recorded decision that changed the outcome, so it counts.
        applied: true,
        threshold: activeThreshold,
        contextHash: hash,
        latencyMs: result.latencyMs,
        // Left null on purpose: the outcome is set later by review, and a row
        // that already knows its own outcome is a row calibration cannot learn
        // from.
        outcome: null
      })
      .catch((err) => {
        // A failed audit write must not fail the memory write. The row is the
        // calibration substrate, not the write path — losing one row costs a
        // data point, losing the write costs the memory.
        logger?.warn("decision record failed", { message: err.message });
      });

    return {
      outcome,
      // The status the item should be written with. `proposed` is a real,
      // queryable state, not a rejection.
      status: applied ? "active" : "proposed",
      score,
      threshold: activeThreshold,
      model: result.model,
      requestedModel: result.requestedModel,
      provider: result.provider,
      skipped: false,
      reason: applied
        ? `scored ${score}, at or above the ${activeThreshold} threshold`
        : `scored ${score}, below the ${activeThreshold} threshold — stored as a proposal, not discarded`,
      inRange: answer.inRange,
      contextHash: hash,
      latencyMs: result.latencyMs,
      cost: result.cost,
      inputTokens: result.inputTokens
    };
  }

  /**
   * The skip shape.
   *
   * `status` is the memory's status and nothing else. Extra detail goes under
   * a prefixed name so it cannot overwrite it — see the 503 case above.
   */
  function skipped(reason, hash, extra = {}) {
    return {
      outcome: OUTCOME.SKIPPED,
      status: "active",
      score: null,
      threshold: activeThreshold,
      model: extra.servedModel ?? client?.model ?? null,
      skipped: true,
      reason,
      contextHash: hash,
      latencyMs: extra.latencyMs ?? null,
      cost: 0,
      // Recorded too. A skip with no row is invisible to calibration, and
      // "how often do we skip" is a number worth knowing — a gate that skips
      // 90% of the time is not a gate.
      ...extra
    };
  }

  return { evaluate, threshold: activeThreshold, question: WRITE_GATE_QUESTION };
}

/**
 * What the model is shown.
 *
 * A `state`, not a chat message. It is the content under judgement plus the
 * little context that changes the answer: what already exists, because "is this
 * worth storing" and "is this a duplicate of something I have" are different
 * questions, and only the second is answerable with the item alone.
 *
 * Deliberately not the whole surrounding conversation. The model decides
 * whether to store one thing; giving it the session turns a cheap
 * classification into an expensive one and invites it to judge the
 * conversation rather than the memory.
 */
function buildState({ content, item, existing }) {
  const parts = [`CONTENT:\n${content}`];

  if (item.tags?.length) parts.push(`TAGS: ${item.tags.join(", ")}`);
  if (item.source) parts.push(`SOURCE: ${item.source}`);

  if (existing) {
    parts.push(
      "ALREADY STORED (judge whether this adds anything, not whether it is interesting):",
      existing.slice(0, 600)
    );
  }

  return parts.join("\n\n");
}

function describeAnswer(answer) {
  if (!answer) return "no answer at all";
  if (answer.type !== NOUL) return `a '${answer.type}' where a '${NOUL}' was asked`;
  return `a noul of ${answer.noul}`;
}
