import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Configuration, read once at startup.
 *
 * Every value comes from the environment. There is no config file, because a
 * config file is a place a secret eventually lands. `.env` is read by Compose
 * for the container environment; in development the same values can be
 * exported in the shell.
 */

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
        apiKey: optional("OPENROUTER_API_KEY", ""),
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
