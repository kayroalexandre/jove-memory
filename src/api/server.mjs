import { createServer } from "node:http";

import { loadConfig } from "../config.mjs";
import { createLogger } from "../logger.mjs";
import { createPoolManager } from "../store/pool.mjs";
import { createStore } from "../store/store.mjs";
import { assertSchemaVersion, expectedVersion } from "../store/migrate.mjs";
import { SHARED_WORKSPACE } from "../store/workspace-name.mjs";

/**
 * HTTP server: health and the workspace registry.
 *
 * Phase 2 delivers only what the compose stack needs to prove it comes up
 * clean — a health endpoint that reports each dependency separately, and
 * enough of a surface to provision and inspect workspaces. The memory API
 * proper arrives in Phase 10.
 *
 * The health endpoint deliberately does not fail when a model provider is down.
 * Degraded retrieval is still useful service, and a container that restarts
 * because a third-party API had a bad minute turns a small problem into an
 * outage (ADR-008).
 */

const config = loadConfig();
const logger = createLogger({ level: config.server.logLevel });
const pools = createPoolManager(config, { logger });

/** Build the app without starting it, so tests can drive it in-process. */
export function createApp({ config, logger, pools }) {
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
   * Provider checks are reported without being called.
   *
   * Phase 2's gate is *zero outbound HTTP requests during startup and health
   * check*. A health check that pings OpenRouter to prove the key works would
   * spend money and rate-limit on every container restart. The provider is
   * reported as `unknown` until something actually uses it, and a real probe
   * arrives in Phase 4 when there is a call site to attach it to.
   */
  function checkProviders() {
    const configured = Boolean(config.providers.apiKey);
    const provider = {
      status: configured ? "configured" : "unconfigured",
      // Deliberately not verified. See above.
      verified: false,
      note: configured
        ? "not probed: the health check makes no outbound request by design"
        : "OPENROUTER_API_KEY is not set"
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
    const [postgres, minio] = await Promise.all([checkPostgres(), checkMinio()]);
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
      phase: 2,
      schemaVersion: expectedVersion(),
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: { postgres, minio, providers },
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
          return { workspace, ...stats, capabilities: caps };
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

export function createHttpServer({ config, logger, pools }) {
  const app = createApp({ config, logger, pools });

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
          phase: 2,
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
export async function start({ config, logger, pools }) {
  const server = createHttpServer({ config, logger, pools });

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
  const { server, shutdown } = await start({ config, logger, pools });
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
