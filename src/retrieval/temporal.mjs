/**
 * The temporal arm.
 *
 * Two questions, and they are not the same question:
 *
 *   validity   — "was this true at time T?" (a filter, not a score)
 *   recency    — "how much should a true thing be favoured for being recent?"
 *                (a ranking, computed in JavaScript)
 *
 * The split is deliberate. Validity is boolean and belongs in SQL, where the
 * index on (occurred_start, occurred_end) can use it. Recency is a decaying
 * function of a timestamp against the query's reference time, and doing it in
 * SQL would mean either a non-sargable expression over the whole table or a
 * magic constant baked into a query string.
 *
 * Bitemporal throughout: `recorded_at` is when the system learned something
 * and `occurred_start` is when it became true in the world. "What did I
 * believe in March" needs both, and they routinely disagree — a memory
 * learned today about something that happened in 2019 has a recorded_at of
 * today and an occurred_start of 2019, and ranking it by the wrong one is the
 * difference between "recent knowledge" and "recent event".
 */

/** Half-life in days for the recency decay. Exported so it is reachable. */
export const DEFAULT_HALF_LIFE_DAYS = 180;

const MS_PER_DAY = 86_400_000;

/**
 * Whether an item is true at `at`.
 *
 * The window is half-open on purpose: `[start, end)`. A fact that stopped
 * being true at 12:00 was not true at 12:00 in the sense a caller asking
 * "as of 12:00" means, and a closed interval makes the boundary count twice
 * — once for the item that ended, once for the item that began.
 *
 * A null bound is open-ended: null start means "always was", null end means
 * "still is".
 */
export function isValidAt(item, at) {
  const when = toTime(at);
  if (when === null) return false;

  const start = toTime(item.occurred_start);
  const end = toTime(item.occurred_end);
  const learned = toTime(item.recorded_at);
  const invalidated = toTime(item.invalidated_at);

  // The system learned about it after the moment in question, so it could not
  // have informed an answer then. This is what makes "what did I believe in
  // March" different from "what was true in March".
  if (learned !== null && learned > when) return false;
  if (start !== null && start > when) return false;
  if (end !== null && end <= when) return false;
  if (invalidated !== null && invalidated <= when) return false;

  return true;
}

/**
 * Recency score in [0, 1].
 *
 * Exponential decay with an explicit half-life, not a linear age penalty.
 * Linear decay has to choose a zero point, and any zero point is a date
 * somebody picked by hand. A half-life states the one thing that matters —
 * "after this long it counts half as much" — and needs no other constant.
 *
 * Which timestamp is the reference depends on the question:
 *   `learned`    default. "What do I know about X" is about knowledge.
 *   `occurred`   for "what happened recently", where the event's age is what
 *                the caller means.
 */
export function recency(item, { at = new Date(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS, basis = "learned" } = {}) {
  const when = toTime(at);
  if (when === null) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError(`halfLifeDays must be positive, got ${halfLifeDays}`);
  }

  const field = basis === "occurred" ? "occurred_start" : "recorded_at";
  const stamp = toTime(item[field]);
  // An item with no usable timestamp is not penalised to zero. Absence of
  // information is not evidence of staleness, and scoring it 0 would bury it
  // below every dated item regardless of content.
  if (stamp === null) return 0.5;

  const ageDays = (when - stamp) / MS_PER_DAY;
  // Dated in the future relative to the reference: fully current.
  if (ageDays <= 0) return 1;

  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Score a candidate list and return it ranked.
 *
 * Ties break on id, for the same reason the fusion layer does: a stable order
 * is what makes the Phase 3 determinism gate passable rather than lucky.
 */
export function rankTemporally(items, options = {}) {
  const scored = items.map((item) => ({
    ...item,
    temporal: {
      recency: recency(item, options),
      // Reported so a caller can see *why* something ranked low, and so a
      // missing timestamp is distinguishable from a stale one.
      basis: options.basis ?? "learned",
      reference: toTime(options.at) ?? null,
      undated: toTime(options[options.basis === "occurred" ? "occurred_start" : "recorded_at"]) === null
    }
  }));

  scored.sort(
    (a, b) =>
      b.temporal.recency - a.temporal.recency ||
      b.temporal.recency * (b.item?.importance ?? 1) - a.temporal.recency * (a.item?.importance ?? 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  return scored;
}

/**
 * Filter to items valid at `at`, dropping anything deleted or invalidated.
 *
 * Deleted items are excluded unconditionally, even for an `asOf` query in the
 * past. A deletion is a statement about the record, not about the world: the
 * user asked for that fact to be gone, and honouring it retroactively is a
 * surprise. An `invalidated` fact is a different thing — the fact is
 * retained precisely so a past query can still find it, and that is the whole
 * reason the bitemporal columns exist.
 */
export function filterValidAt(items, at, { includeDeleted = false, includeInvalidated = false } = {}) {
  if (at === null || at === undefined) {
    // "Now" by default. An invalidated fact is excluded unless asked for:
    // the default search should return what is currently believed, and
    // `includeInvalidated` is how a caller asks for the history.
    return items.filter((entry) => {
      const item = entry.item ?? entry;
      if (!includeDeleted && item.deleted_at) return false;
      if (includeInvalidated) return true;
      return !item.invalidated_at;
    });
  }

  return items.filter((entry) => {
    const item = entry.item ?? entry;
    if (!includeDeleted && item.deleted_at) return false;
    if (includeInvalidated) return true;
    // An explicitly requested moment overrides the invalidated filter: asking
    // about March is how you find out what you believed in March, including
    // the things you have since learned were wrong.
    return isValidAt(item, at);
  });
}

function toTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
