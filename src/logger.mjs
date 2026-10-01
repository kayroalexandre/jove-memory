/**
 * Logger with redaction.
 *
 * This is the only sanctioned way to emit anything. `console.log` is rejected
 * by the linter (test/invariants.test.mjs), because a stray log of a request
 * body would put memory content on disk and possibly in a CI log.
 *
 * Rules:
 *   - Never log a value under a key that suggests it is sensitive
 *   - Never log a request or response body
 *   - Redact rather than drop, so a shape is still visible in the log
 */

/** Key fragments that mark a value as never-loggable. */
const SENSITIVE_KEY_FRAGMENTS = [
  "apikey",
  "api_key",
  "authorization",
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "private_key",
  "session_key",
  "cookie"
];

/** Value shapes that are always redacted regardless of the key. */
const SENSITIVE_VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i
];

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** Replace anything sensitive in a string, preserving length roughly. */
export function redactString(value) {
  let out = String(value);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (match.length <= 12) return "[redacted]";
      return `${match.slice(0, 4)}…[redacted:${match.length}]`;
    });
  }
  return out;
}

/**
 * Deep-redact an object. Keys matching a sensitive fragment get a placeholder;
 * strings get pattern-scrubbed. Depth-limited so a cycle or a huge payload
 * cannot hang the logger.
 */
export function redact(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const lower = key.toLowerCase().replace(/[-\s]/g, "_");
      const sensitive = SENSITIVE_KEY_FRAGMENTS.some((frag) => lower.includes(frag));
      out[key] = sensitive ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return "[unloggable]";
}

export function createLogger({ level = "info", stream = process.stderr, sink = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, context) {
    if (LEVELS[levelName] > threshold) return;
    const record = {
      at: new Date().toISOString(),
      level: levelName,
      message: redactString(message),
      ...(context ? { context: redact(context) } : {})
    };
    if (sink) sink(record);
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    error: (message, context) => emit("error", message, context),
    warn: (message, context) => emit("warn", message, context),
    info: (message, context) => emit("info", message, context),
    debug: (message, context) => emit("debug", message, context),
    /** Attach a sink so tests can assert on records instead of parsing text. */
    withSink: (fn) => sink && fn
  };
}
