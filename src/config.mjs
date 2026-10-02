import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");

/**
 * Configuration, read once at startup.
 *
 * Every value comes from the environment. There is no config file, because a
 * config file is a place a secret eventually lands. `.env` is read by Compose
 * for the container environment; in development the same values can be
 * exported in the shell.
 *
 * One exception, and it is deliberate: the provider key may come from a *file
 * outside this repository* (see `readApiKey`). A key pasted into a shell
 * command lands in that shell's history, and a key typed into `.env` sits in
 * the project directory where a `git add .` and a public repo will eventually
 * publish it. Neither is a risk worth taking for something that costs
 * fractions of a cent a day, so the supported path is a file the user creates
 * once, with restrictive permissions, in their own home directory.
 */

/**
 * Refuse to read a key from inside the repository.
 *
 * The file would be gitignored, and a gitignored file is still a file in a
 * directory that gets zipped, backed up, and rsynced. A key in `~/.config`
 * is outside all of that by construction. This is a hard error rather than a
 * warning, because a warning is something that gets clicked past exactly once.
 *
 * Compared as resolved paths against the repository root. An earlier version
 * tested for the substring `jove-memory` anywhere in the path, which rejected
 * the very file this points at — `~/.config/jove-memory/openrouter.key` — and
 * would also have rejected an unrelated directory with the same name
 * somewhere else on the disk.
 */
function assertOutsideRepository(path) {
  const expanded = path.startsWith("~")
    ? join(process.env.HOME ?? homedir(), path.slice(1))
    : path;
  const resolved = resolve(expanded);
  const root = resolve(SRC_ROOT);

  if (resolved !== root && !resolved.startsWith(root + sep)) return;

  throw new Error(
    `Refusing to read a provider key from inside the project: ${resolved}\n` +
      "  A file in the repository is one `git add .`, one backup and one rsync\n" +
      "  away from being published. The key belongs in your home directory.\n" +
      '  See docs/OPERATIONS.md, "Storing the provider key".'
  );
}

/**
 * Where a key file may live, as directories, in preference order.
 *
 * Exported so `scripts/set-provider-key.mjs` and this module cannot drift
 * apart. That drift is not hypothetical: the first version of the setup script
 * hardcoded `~/.config/jove-memory` while this module looked in two other
 * places, so a key written by one could be invisible to the other.
 *
 * `~/.config` is listed first because it is the conventional location, but it
 * is not assumed to exist. On this machine it is owned by root, and a
 * directory another user owns is not a place to put a credential — the setup
 * script falls through to the next candidate rather than failing, and says
 * which one it used.
 */
export function keyDirectoryCandidates(env = process.env) {
  if (env.JOVE_SECRETS_DIR) return [env.JOVE_SECRETS_DIR];

  return [
    join(homedir(), ".config", "jove-memory"),
    join(homedir(), ".local", "share", "jove-memory"),
    join(homedir(), ".jove-memory")
  ];
}

/**
 * Every file the key may be read from, in order.
 *
 * The environment is handled separately and first — it is not a file, and it
 * must win over a stale one on disk.
 */
export function keyFileCandidates(env = process.env) {
  const paths = [];

  if (env.OPENROUTER_API_KEY_FILE) paths.push(env.OPENROUTER_API_KEY_FILE);

  for (const dir of keyDirectoryCandidates(env)) {
    paths.push(join(dir, "openrouter.key"));
  }

  // Where compose.yml mounts that directory, so a container and a local
  // process read the same file and there is exactly one place to look.
  paths.push("/run/secrets/jove/openrouter.key");
  // The conventional single-file mount, for `docker run --mount type=secret`
  // and for orchestrators that mount files rather than directories.
  paths.push("/run/secrets/openrouter_api_key");

  return paths;
}

/**
 * Read the OpenRouter key, in order of preference.
 *
 *   1. `OPENROUTER_API_KEY` in the environment. For CI and for anyone who
 *      already exports it. A key in an environment variable is invisible to
 *      `git status` and to a directory listing.
 *   2. A key file. See `keyFileCandidates`.
 *
 * Trailing whitespace and surrounding quotes are stripped. A key pasted from a
 * web page very often arrives with one or both, and a key with a trailing
 * newline in a file is the single most common way an otherwise-correct setup
 * fails with a 401 that looks like a wrong key.
 */
function readApiKey(env) {
  resolvedKeySource = null;

  const fromEnv = optional("OPENROUTER_API_KEY", "");
  if (fromEnv) {
    resolvedKeySource = "environment";
    return fromEnv.trim();
  }

  for (const path of keyFileCandidates(env)) {
    if (!path) continue;
    assertOutsideRepository(path);
    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      // Not an error. Most deployments have no key, and the health endpoint
      // has to work without one (Phase 2's gate).
      continue;
    }
    const key = contents.trim().replace(/^["']|["']$/g, "").trim();
    if (key) {
      resolvedKeySource = `file:${path}`;
      return key;
    }
  }
  return "";
}

function required(name, { allowEmpty = false } = {}) {
  const value = process.env[name];
  if (value === undefined || (value === "" && !allowEmpty)) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in, ` +
        `or export it in the environment. Never commit a populated value.`
    );
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Resolve the key and remember which source produced it.
 *
 * A module-level variable rather than returning a pair, because `loadConfig`
 * has to keep returning a plain object and threading a second return value
 * through every caller would be noise. Reset at the top of every call, so two
 * loads with different environments cannot report each other's source.
 */
let resolvedKeySource = null;

function apiKeySource() {
  return resolvedKeySource;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  if (env !== process.env) process.env = env;
  try {
    return {
      server: {
        // Binds 0.0.0.0 *inside the container*. That is not exposure: the
        // host publishes this port on 127.0.0.1 only (compose.yml), so the
        // service is unreachable from the network.
        //
        // The distinction matters. Binding 127.0.0.1 inside a container makes
        // the port unreachable from the Docker bridge, which is why the
        // container's own healthcheck and the host's published port both fail
        // while the logs cheerfully say "listening".
        host: optional("PARADIGM_HOST", "0.0.0.0"),
        port: int("PARADIGM_API_PORT", 8888),
        logLevel: optional("PARADIGM_LOG_LEVEL", "info")
      },

      postgres: {
        // In Compose the host is the service name; locally it is localhost.
        host: optional("POSTGRES_HOST", "127.0.0.1"),
        port: int("POSTGRES_PORT", 5432),
        superuser: optional("POSTGRES_SUPERUSER", "paradigm"),
        password: required("POSTGRES_PASSWORD"),
        database: optional("POSTGRES_DB", "paradigm"),
        poolMaxPerWorkspace: int("POSTGRES_POOL_MAX_PER_WORKSPACE", 4)
      },

      minio: {
        endpoint: optional("MINIO_ENDPOINT", "127.0.0.1"),
        port: int("MINIO_PORT", 9000),
        accessKey: optional("MINIO_ROOT_USER", ""),
        secretKey: optional("MINIO_ROOT_PASSWORD", ""),
        bucket: optional("MINIO_BUCKET", "jove-media"),
        region: optional("MINIO_REGION", "us-east-1")
      },

      providers: {
        // Not `required`. The stack must be able to start, and serve health,
        // before any key exists — that is Phase 2's whole gate. A missing key
        // makes every provider-backed operation fail loudly at the call site,
        // which is where the error is actionable, rather than at boot where it
        // only says "something is unset".
        //
        // The health endpoint reports the absence. Nothing silently degrades.
        //
        // Read from a file as well as the environment — see `readApiKey`.
        apiKey: readApiKey(env),
      // Which of the three sources answered, for the health endpoint. Never
      // the value. "I set it and the container cannot see it" and "I never set
      // it" are the two failures people actually hit, and the source tells
      // them apart immediately.
      keySource: apiKeySource(),
        baseUrl: optional("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        embedModel: optional("PARADIGM_EMBED_MODEL", "google/gemini-embedding-2"),
        decisionModel: optional("PARADIGM_DECISION_MODEL", "upstage/solar-decide"),
        inferenceModel: optional("PARADIGM_INFERENCE_MODEL", "qwen/qwen3.8-flash"),
        fallbackInferenceModel: optional(
          "PARADIGM_FALLBACK_INFERENCE_MODEL",
          "deepseek/deepseek-v4-flash"
        ),
        requestTimeoutMs: int("PARADIGM_PROVIDER_TIMEOUT_MS", 30000)
      },

      thresholds: {
        // Starting values, not final ones. These get measured, not trusted.
        // See docs/THRESHOLDS.md.
        writeGate: Number(optional("PARADIGM_THRESHOLD_WRITE_GATE", "0.60")),
        rerank: Number(optional("PARADIGM_THRESHOLD_RERANK", "0.60")),
        crossWorkspace: Number(optional("PARADIGM_THRESHOLD_CROSS_WORKSPACE", "0.75"))
      },

      embedding: {
        // 3072 for gemini-embedding-2. The schema is created at this width, so
        // changing it means re-embedding everything (ADR-005).
        dimensions: int("PARADIGM_EMBED_DIMENSIONS", 3072),
        // Texts per HTTP request. Not a tuning knob for speed: it is a request
        // size, and one 100-item batch that gets rejected costs more than ten
        // accepted ones. 32 keeps a batch well inside every provider's limit
        // while still amortising the round trip.
        batchSize: int("PARADIGM_EMBED_BATCH_SIZE", 32)
      }
    };
  } finally {
    if (env !== previous) process.env = previous;
  }
}

export { HERE as SRC_DIR };
