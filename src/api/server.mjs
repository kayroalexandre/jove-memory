import { createServer } from "node:http";

import { loadConfig } from "../config.mjs";
import { createLogger } from "../logger.mjs";
import { createPoolManager } from "../store/pool.mjs";
import { createStore } from "../store/store.mjs";
import { assertSchemaVersion, expectedVersion } from "../store/migrate.mjs";
import { SHARED_WORKSPACE } from "../store/workspace-name.mjs";
import { createEmbedder } from "../embedding/openrouter.mjs";

/**
 * HTTP server: health and the workspace registry.
 *
 * Phase 2 delivered what the compose stack needs to prove it comes up clean.
 * Phase 4 adds the one thing that reads outside this machine: an embedder, so
 * health can report index completeness without spending a request to find out.
 *
 * The health endpoint deliberately does not fail when a model provider is down.
 * Degraded retrieval is still useful service, and a container that restarts
 * because a third-party API had a bad minute turns a small problem into an
 * outage (ADR-008).
 *
 * Module-level construction, because the import of this file *is* the server
 * and every other module in the project follows the same shape. Tests build
 * their own instances through `createApp`.
 */

const config = loadConfig();
const logger = createLogger({ level: config.server.logLevel });
const pools = createPoolManager(config, { logger });

/**
 * The embedder, or null when no key is configured.
 *
 * Constructed eagerly and never used at boot. The client makes no request in
 * its constructor, so this costs nothing — and constructing it lazily on first
 * search would move a configuration error into the hot path, where it would
 * surface as one failed query rather than as a clear message.
 */
const embedder = config.providers.apiKey ? createEmbedder({ config, logger }) : null;

if (!embedder) {
  logger.warn("no embedding provider configured", {
    note: "retrieval runs on three layers; set OPENROUTER_API_KEY for the vector arm"
  });
}

/**
 * Build the app without starting it, so tests can drive it in-process.
 *
 * `embedder` is optional and defaults to null. It is null in CI and in any
 * build without a key, and the health endpoint has to work there — which is
 * the same reasoning as the health check making no outbound request.
 */
export function createApp({ config, logger, pools, embedder = null }) {
  async function checkPostgres() {
    try {
      const workspaces = await pools.listWorkspaces({ includeInfrastructure: true });
      return {
        status: workspaces.length > 0 ? "healthy" : "degraded",
        workspaces: workspaces.length,
        note: workspaces.length === 0 ? "no workspace databases provisioned" : null
      };
    } catch (err) {
      return { status: "unreachable", message: err.message, code: err.code ?? null };
    }
  }

  /**
   * Index completeness, per workspace.
   *
   * Not a health signal. A corpus that is 30% unembedded retrieves perfectly
   * well, on three layers instead of four — calling that degraded would make
   * `/health` noisy and train a reader to ignore it. It is reported because
   * the question "is my index complete" is asked constantly and the answer
   * should not require a query.
   *
   * Null coverage means the count could not be taken, which is different from
   * zero embedded.
   */
  async function checkIndexing() {
    if (!embedder) {
      return { status: "no embedder configured", note: "the vector arm is disabled in this build" };
    }
    try {
      const workspaces = await pools.listWorkspaces();
      const detail = {};

      for (const workspace of workspaces) {
        const store = createStore({ workspace, pools, logger });
        try {
          detail[workspace] = await store.vectorCoverageSummary({ model: embedder.model });
        } catch (err) {
          // An unmigrated workspace has no such table. Reported, not fatal.
          detail[workspace] = { error: err.message };
        }
      }
      return { model: embedder.model, dimensions: embedder.dimensions, workspaces: detail };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Provider checks are reported without being called.
   *
   * Phase 2's gate is *zero outbound HTTP requests during startup and health
   * check*. That gate holds, and Phase 4 makes it more important rather than
   * less: a health check that embeds a test string to prove the key works
   * spends money and burns rate-limit on every container restart, and every
   * orchestrator's liveness probe would do it on a schedule.
   *
   * So the key is checked for *presence*, never for validity. The first real
   * use is what proves it works, and a failure there is reported by the search
   * that hit it — with `debug.semantic_error` naming the cause — rather than
   * by a background ping nobody asked for.
   */
  function checkProviders() {
    const configured = Boolean(config.providers.apiKey);
    const provider = {
      status: configured ? "configured" : "unconfigured",
      // Deliberately not verified, and it stays that way. See above.
      verified: false,
      note: configured
        ? "not probed: the health check makes no outbound request by design"
        : "OPENROUTER_API_KEY is not set; retrieval runs on three layers"
    };
    return {
      openrouter: provider,
      embedModel: config.providers.embedModel,
      decisionModel: config.providers.decisionModel,
      inferenceModel: config.providers.inferenceModel
    };
  }

  async function checkMinio() {
    // MinIO speaks S3; probing it means an S3 client. That lands in Phase 7
    // with the rest of the media work. Until then the container's own
    // healthcheck covers liveness, and this reports honestly that the
    // application has not verified it yet.
    return {
      status: "unchecked",
      endpoint: `${config.minio.endpoint}:${config.minio.port}`,
      note: "the S3 client arrives in Phase 7; container healthcheck covers liveness"
    };
  }

  async function handleHealth() {
    const [postgres, minio, indexing] = await Promise.all([
      checkPostgres(),
      checkMinio(),
      checkIndexing()
    ]);
    const providers = checkProviders();

    // Overall status is about whether THIS PROCESS can serve. A provider
    // outage degrades quality, it does not make the container unhealthy.
    const healthy = postgres.status === "healthy" || postgres.status === "degraded";
    const degraded = [];

    if (postgres.status === "unreachable") degraded.push("postgres");
    if (providers.openrouter.status !== "configured") degraded.push("openrouter");

    return {
      status: healthy ? (degraded.length > 0 ? "degraded" : "ok") : "unhealthy",
      service: "jove-memory",
      version: "0.1.0",
      // Reported rather than assumed. Phase 2 hardcoded 2 and it stayed there
      // through Phase 3, which is the kind of stale number nobody notices
      // because it is not wrong-looking.
      phase: 4,
      schemaVersion: expectedVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: { postgres, minio, providers },
      // Index completeness, deliberately outside `dependencies`. It is not a
      // dependency — nothing is broken by it — and putting it there would make
      // a half-embedded corpus look like an outage.
      indexing,
      degraded
    };
  }

  async function handleWorkspaces() {
    const names = await pools.listWorkspaces();
    const detail = await Promise.all(
      names.map(async (workspace) => {
        const store = createStore({ workspace, pools, logger });
        try {
          const stats = await store.stats();
          const caps = await store.capabilities();
          // Coverage alongside the counts. A workspace with 5000 items and 0
          // vectors looks healthy in a stats listing and retrieves on three
          // layers, which is exactly the surprise this removes.
          const coverage = embedder
            ? await store.vectorCoverageSummary({ model: embedder.model })
            : null;
          return { workspace, ...stats, capabilities: caps, vectorCoverage: coverage };
        } catch (err) {
          // An unmigrated or unreachable workspace is reported, not hidden.
          return { workspace, error: err.message };
        }
      })
    );
    return { workspaces: detail, shared: SHARED_WORKSPACE };
  }

  async function handleWorkspaceStats(name) {
    const workspace = decodeURIComponent(name);
    const store = createStore({ workspace, pools, logger });
    const [stats, capabilities, health] = await Promise.all([
      store.stats(),
      store.capabilities(),
      store.health()
    ]);
    return { ...stats, capabilities, health };
  }

  return { handleHealth, handleWorkspaces, handleWorkspaceStats };
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // This is a localhost-only service holding personal memory. No caching.
    "cache-control": "no-store"
  });
  res.end(payload);
}

export function createHttpServer({ config, logger, pools, embedder = null }) {
  const app = createApp({ config, logger, pools, embedder });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const started = Date.now();

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const body = await app.handleHealth();
        return send(res, body.status === "unhealthy" ? 503 : 200, body);
      }

      if (req.method === "GET" && url.pathname === "/v1/workspaces") {
        return send(res, 200, await app.handleWorkspaces());
      }

      const statsMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/stats$/);
      if (req.method === "GET" && statsMatch) {
        return send(res, 200, await app.handleWorkspaceStats(statsMatch[1]));
      }

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, {
          service: "jove-memory",
          phase: 4,
          endpoints: ["/health", "/v1/workspaces"]
        });
      }

      send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      // Log the cause, return a generic message. The cause may contain a
      // connection string with a password, and this body goes to whoever is
      // calling — which, for a localhost service, still means it reaches a log.
      logger.error("request failed", {
        path: url.pathname,
        method: req.method,
        message: err.message,
        code: err.code ?? null
      });
      send(res, 500, { error: "internal_error" });
    } finally {
      logger.debug("request", {
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started
      });
    }
  });

  return server;
}

/** Start the server and wire graceful shutdown. */
export async function start({ config, logger, pools, embedder = null }) {
  const server = createHttpServer({ config, logger, pools, embedder });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Binds to loopback by default. See docs/SECURITY.md — this service holds
    // personal memory content and has no authentication layer, so exposure is
    // a decision, not a config default.
    server.listen(config.server.port, config.server.host, resolve);
  });

  logger.info("listening", { host: config.server.host, port: config.server.port });

  if (config.server.host === "0.0.0.0") {
    // Worth saying out loud, because "binds all interfaces" reads alarming in
    // a log and the actual exposure is decided by compose.yml's port mapping.
    logger.info(
      "bound to all interfaces inside the container; host exposure is decided by compose.yml"
    );
  }

  // Refuse to start against a database whose schema this build does not
  // recognise, rather than failing later with a confusing error.
  const workspaces = await pools.listWorkspaces();
  for (const workspace of workspaces) {
    try {
      await assertSchemaVersion(pools.poolFor(workspace));
    } catch (err) {
      logger.error("schema version mismatch", { workspace, message: err.message });
      await pools.close();
      throw err;
    }
  }
  logger.info("schema verified", { workspaces: workspaces.length });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });

    // Stop accepting connections first, then close pools. Doing it the other
    // way round lets an in-flight request hit a closed pool.
    await new Promise((resolve) => server.close(resolve));
    await pools.close();
    logger.info("shutdown complete");
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      shutdown(signal).then(() => process.exit(0));
    });
  }

  return { server, shutdown };
}

async function main() {
  const { server, shutdown } = await start({ config, logger, pools, embedder });
  // Keep the process alive; the http server does that on its own, but an
  // unhandled rejection should not leave a half-dead container.
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { message: reason?.message ?? String(reason) });
  });
  void server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
