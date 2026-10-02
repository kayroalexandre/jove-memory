import { createServer } from "node:http";

import { loadConfig } from "../config.mjs";
import { createLogger } from "../logger.mjs";
import { createPoolManager } from "../store/pool.mjs";
import { createStore } from "../store/store.mjs";
import { assertSchemaVersion, expectedVersion } from "../store/migrate.mjs";
import { SHARED_WORKSPACE, DEFAULT_WORKSPACE } from "../store/workspace-name.mjs";
import { createEmbedder } from "../embedding/openrouter.mjs";
import { createCredentialStore } from "./credentials.mjs";
import { settingsPage } from "./settings-page.mjs";

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
const keySource = config.providers.keySource;

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
export function createApp({
  config,
  logger,
  pools,
  embedder = null,
  keySource = null,
  credentials = null,
  store = null,
  buildEmbedder = null
}) {
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
      return {
        status: "no embedder configured",
        // Whether the absence is a missing file or an unissued key. The two
        // have completely different fixes, and "no embedder configured" on its
        // own sends the reader to the wrong one of them.
        detail: keySource
          ? "OPENROUTER_API_KEY is empty or unreadable at the configured path"
          : "no key configured; run `npm run key:set`, or set OPENROUTER_API_KEY",
        note: "the vector arm is disabled in this build"
      };
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
        : "no provider key found; retrieval runs on three layers",
      // Where the key came from, never what it is. Useful for telling "I set
      // it and the container cannot see it" apart from "I never set it", which
      // are the two failures people actually hit with a key in a file.
      source: configured ? keySource : null
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

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /**
   * The current state of a credential, with no value in it.
   *
   * `configured: false` rather than a 404. "No key" is a normal state that the
   * page has to render, not an error.
   */
  async function handleCredentialState({ provider = "openrouter", kind = "api_key" } = {}) {
    if (!credentials) {
      return {
        credential: null,
        error: "credentials are not available in this build"
      };
    }
    return {
      credential: await credentials.describe({ provider, kind }),
      masterKeyPath: credentials.masterKeyPath(),
      masterKeyCreated: credentials.masterKeyCreated()
    };
  }

  /**
   * Store, verify or clear a credential.
   *
   * The body is read with a hard size cap. A settings endpoint that accepts an
   * unbounded body is a memory-exhaustion target, and this one is on a port
   * bound to loopback, where "who could reach it" is a question worth asking
   * anyway.
   *
   * The value is never logged, never echoed, and never included in an error
   * message. The `value` field is read out of the body and the body is dropped
   * immediately after.
   */
  async function handleCredentialWrite(body) {
    if (!credentials) throw new Error("credentials are not available in this build");

    const action = body?.action ?? "save";
    const provider = body?.provider ?? "openrouter";
    const kind = body?.kind ?? "api_key";

    if (action === "clear") {
      const removed = await credentials.clear({ provider, kind, note: body?.note ?? null });
      return {
        ok: true,
        removed,
        credential: await credentials.describe({ provider, kind }),
        message: removed
          ? "Removed. Retrieval runs on three layers until a key is set again."
          : "There was no key to remove."
      };
    }

    const value = typeof body?.value === "string" ? body.value : "";
    if (value.trim() === "") {
      // 400 with a message the form can show. The value is absent, so there is
      // nothing to leak.
      return { ok: false, status: 400, detail: "paste a key first" };
    }

    // Verified before stored, not after. The point of the form is that the
    // operator learns a key is wrong here rather than from a failed search
    // twenty minutes later.
    if (action === "verify") {
      // The candidate key, not the configured one. Verifying the old key
      // while testing the new one is a check that always passes.
      //
      // Injectable so a test can drive this without a network call. The first
      // version built the client inline and ignored whatever the caller
      // supplied, so a test asserting "a rejected key is not stored" made a
      // real request to OpenRouter on every run — spending money and
      // depending on a third party's mood for a storage property.
      //
      // `undefined` means "not supplied, build the real one"; an explicit
      // `null` means "there is no client", which is a state worth testing
      // because it is what a keyless deployment is in. `??` conflates the two,
      // and did, so the not-configured path was unreachable.
      const makeEmbedder =
        buildEmbedder === undefined
          ? (candidate) =>
              createEmbedder({
                config: { ...config, providers: { ...config.providers, apiKey: candidate } },
                logger
              })
          : buildEmbedder;

      const check = await credentials.verify({
        value,
        buildEmbedder: makeEmbedder,
        dimensions: config.embedding.dimensions
      });

      if (check.ok === null) {
        // Unverifiable, not wrong. Storing anyway is the right call and saying
        // so is the important part.
        const saved = await credentials.set({ provider, kind, value, note: "stored without verification" });
        return {
          ok: true,
          verified: false,
          credential: saved,
          // Short, and says the thing that matters. The first version appended
          // the reason twice over and read like a sentence assembled by parts.
          message: `Saved, but not verified: ${check.detail}.`
        };
      }

      if (!check.ok) {
        // Nothing is stored. A rejected key must not land in the table as a
        // fallback that something else picks up later.
        return { ok: false, status: 400, reason: check.reason, detail: check.detail };
      }
    }

    const saved = await credentials.set({ provider, kind, value });
    return {
      ok: true,
      credential: saved,
      message: saved.changed
        ? "Saved. The key is encrypted and will never be shown again."
        : "Unchanged — that is the same key already stored."
    };
  }

  return {
    handleHealth,
    handleWorkspaces,
    handleWorkspaceStats,
    handleCredentialState,
    handleCredentialWrite
  };
}

/**
 * Body size cap for the settings endpoint.
 *
 * 8 KiB is about four hundred times a key. A settings endpoint that accepts an
 * unbounded body is a memory-exhaustion target, and this one is on a port
 * bound to loopback — where "who could reach it" deserves the same question as
 * anywhere else.
 */
const MAX_BODY_BYTES = 8 * 1024;

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

/**
 * HTML response.
 *
 * The security headers are the point of this function rather than an
 * afterthought. A page that accepts a credential and serves it on loopback
 * still deserves to say: no framing, no sniffing, no referrer.
 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    // The page loads nothing from anywhere. A CSP that says so makes that a
    // property the browser enforces rather than a claim in a comment.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(html);
}

/**
 * Read a JSON body, with a cap.
 *
 * The cap is enforced against the declared content-length *and* the actual
 * bytes, because a lying header is the standard way past a length check.
 */
async function readJsonBody(req) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`), { status: 413 });
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`), { status: 413 });
    }
    chunks.push(chunk);
  }

  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Body is not valid JSON"), { status: 400 });
  }
}

/** Drop undefined fields, so a response shape does not vary for no reason. */
function stripUndefined(body) {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

export function createHttpServer({
  config,
  logger,
  pools,
  embedder = null,
  keySource = null,
  store = null,
  credentials = null,
  buildEmbedder = null
}) {
  // The credential store is per-workspace, like every other store, because
  // one database per workspace is the design (ADR-003). A credential written
  // into the `main` workspace is not visible from `geos`, which is the same
  // rule that keeps one workspace's memories out of another's searches.
  const credentialStore =
    credentials ??
    (store ? createCredentialStore({ store, logger }) : null);

  const app = createApp({
    config,
    logger,
    pools,
    embedder,
    keySource,
    credentials: credentialStore,
    buildEmbedder
  });

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

      if (req.method === "GET" && url.pathname === "/settings") {
        return sendHtml(res, 200, settingsPage());
      }

      if (req.method === "GET" && url.pathname === "/v1/settings/credentials") {
        return send(res, 200, await app.handleCredentialState());
      }

      if (req.method === "POST" && url.pathname === "/v1/settings/credentials") {
        const body = await readJsonBody(req);
        const result = await app.handleCredentialWrite(body);
        // 400 for a rejected key, 200 for anything accepted. The distinction
        // matters: a rejected key is not stored, and the response says so.
        return send(res, result.status ?? 200, stripUndefined(result));
      }

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, {
          service: "jove-memory",
          phase: 4,
          endpoints: ["/health", "/v1/workspaces", "/settings", "/v1/settings/credentials"]
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
      // A status attached by a handler is the answer, not a fallback. The
      // first version collapsed every failure to 500, so a 413 "body too
      // large" and a 400 "malformed JSON" were indistinguishable to a client.
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 500;
      send(res, status, {
        error: status === 500 ? "internal_error" : "bad_request",
        detail: status === 500 ? null : err.message
      });
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
export async function start({
  config,
  logger,
  pools,
  embedder = null,
  keySource = null,
  store = null,
  credentials = null,
  buildEmbedder = null
}) {
  const server = createHttpServer({ config, logger, pools, embedder, keySource, store, credentials });

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
  // Which workspace the settings form writes to.
  //
  // Credentials are per-workspace like everything else (ADR-003): a key stored
  // in `main` is not visible from another workspace, which is the same rule
  // that keeps one workspace's memories out of another's searches. It is a
  // deliberate consequence — a key configured for one workspace is not a key
  // configured for all of them.
  const settingsWorkspace = process.env.JOVE_WORKSPACE ?? DEFAULT_WORKSPACE;
  const store = createStore({ workspace: settingsWorkspace, pools, logger });

  const { server, shutdown } = await start({
    config,
    logger,
    pools,
    embedder,
    keySource,
    store
  });
  logger.info("settings workspace", { workspace: settingsWorkspace });
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
