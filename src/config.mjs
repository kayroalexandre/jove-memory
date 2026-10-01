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
        host: optional("PARADIGM_HOST", "127.0.0.1"),
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
        poolMaxPerWorkspace: int("POSTGRES_POOL_MAX_PER_WORKSPACE", 10)
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
        apiKey: required("OPENROUTER_API_KEY"),
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
        dimensions: int("PARADIGM_EMBED_DIMENSIONS", 3072)
      }
    };
  } finally {
    if (env !== previous) process.env = previous;
  }
}

export { HERE as SRC_DIR };
