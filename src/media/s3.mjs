import { createHash, createHmac } from "node:crypto";

/**
 * A minimal S3 client.
 *
 * Why not `@aws-sdk/client-s3`: it is a correct, well-tested implementation of
 * exactly this, and it brings several hundred transitive packages into an image
 * whose entire premise is being small. The surface actually needed here is five
 * operations against an S3-compatible endpoint, all of them SigV4-signed POSTs
 * with a payload hash.
 *
 * What that trade costs, stated plainly: this is not a general-purpose S3
 * client. It does not do multipart upload, does not do presigned URLs, does not
 * retry a 1000-continue, and does not support SSE-C or KMS. If a feature needs
 * one of those, the answer is the SDK — not extending this until it is one.
 *
 * ## SigV4
 *
 * The signing algorithm is implemented rather than delegated, because there is no
 * off-the-shelf way to sign a request in Node without a dependency. It is
 * deterministic and fully specified, and the test suite signs a known request and
 * compares against a value computed by hand from the specification, so a change
 * in the algorithm shows up as a signature mismatch rather than as a 403 from a
 * third party at 3am.
 *
 * The region matters even though MinIO does not care: the signature covers it.
 */

/** SHA-256 of the empty string, which the specification requires verbatim. */
const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");

export class S3Error extends Error {
  constructor(status, code, message, key) {
    super(`S3 ${status}${code ? ` ${code}` : ""}: ${message}${key ? ` (${key})` : ""}`);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

export function createS3Client({
  config,
  logger = null,
  fetch: fetchImpl = globalThis.fetch
}) {
  const endpoint = config.minio.endpoint.includes("://")
    ? config.minio.endpoint
    : `http://${config.minio.endpoint}${config.minio.port ? `:${config.minio.port}` : ""}`;

  // The host that goes into the signature, including a non-default port.
  //
  // `new URL('http://minio').host` is `minio`, not `minio:9000`. S3 requires
  // the Host header to match what the client would have connected to, port
  // included, so a host without it produces a signature the service rejects —
  // and a 403 on a request that is otherwise correct reads as a credentials
  // problem, which sends the reader looking at the wrong thing entirely.
  const signingHost = new URL(endpoint).host;
  const region = process.env.S3_REGION ?? "us-east-1";

  // Path-style addressing throughout. Virtual-host style would put the bucket
  // in the hostname, which needs DNS wildcards that a laptop and a single-host
  // deployment both do not have.
  const urlFor = (key) =>
    `${endpoint.replace(/\/+$/, "")}/${config.minio.bucket}/${encodeKey(key)}`;

  /**
   * Put an object.
   *
   * @param {string} key
   * @param {Buffer|Uint8Array|string} body
   * @param {object} [options]
   * @param {string} [options.contentType]
   * @returns {Promise<{etag, sha256, size}>}
   */
  async function put(key, body, { contentType = "application/octet-stream", metadata = {} } = {}) {
    const payload = toBuffer(body);
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const headers = await signedHeaders({
      method: "PUT",
      path: `/${config.minio.bucket}/${encodeKey(key)}`,
      payloadHash: sha256,
      contentType,
      contentLength: payload.length,
      extra: metadataHeaders(metadata)
    });

    let response;
    try {
      response = await fetchImpl(urlFor(key), { method: "PUT", headers, body: payload });
    } catch (err) {
      // `fetch failed` on its own is useless. The cause carries the DNS
      // failure, the refused connection, or the TLS error, and reporting only
      // the wrapper turns a configuration problem into a mystery.
      throw new S3Error(0, "NetworkError", withCause(err, key), key);
    }

    if (!response.ok) {
      throw await toError(response, key);
    }

    return {
      key,
      // Recorded and explicitly not trusted. A multipart upload's ETag looks
      // like `abc-3` and is not a content hash, so using it as integrity proof
      // would pass verification for a file that was truncated across parts.
      // (ADR-011)
      etag: response.headers.get("etag"),
      sha256,
      size: payload.length
    };
  }

  /**
   * Get an object.
   *
   * `verify` recomputes the sha256 rather than trusting anything the service
   * reports. That is the whole point of ADR-011: the store is not the authority
   * on whether the bytes are the bytes.
   */
  async function get(key, { verify = true } = {}) {
    const headers = await signedHeaders({
      method: "GET",
      path: `/${config.minio.bucket}/${encodeKey(key)}`,
      payloadHash: EMPTY_PAYLOAD_HASH
    });

    let response;
    try {
      response = await fetchImpl(urlFor(key), { method: "GET", headers });
    } catch (err) {
      throw new S3Error(0, "NetworkError", withCause(err, key), key);
    }
    if (!response.ok) throw await toError(response, key);

    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reported = response.headers.get("x-amz-meta-sha256");
    const etag = response.headers.get("etag");

    if (verify && reported && reported !== sha256) {
      // A stored object whose bytes no longer hash to what was recorded. This
      // is corruption or tampering, and it must not be handed back as if it
      // were the file the caller asked for.
      throw new S3Error(
        200,
        "IntegrityMismatch",
        `the stored object does not match its recorded sha256 ` +
          `(recorded ${reported.slice(0, 12)}…, computed ${sha256.slice(0, 12)}…)`,
        key
      );
    }

    return {
      key,
      body: bytes,
      sha256,
      etag,
      contentType: response.headers.get("content-type"),
      size: bytes.length
    };
  }

  /** Head an object: existence and size, without the body. */
  async function head(key) {
    const headers = await signedHeaders({
      method: "HEAD",
      path: `/${config.minio.bucket}/${encodeKey(key)}`,
      payloadHash: EMPTY_PAYLOAD_HASH
    });

    let response;
    try {
      response = await fetchImpl(urlFor(key), { method: "HEAD", headers });
    } catch (err) {
      throw new S3Error(0, "NetworkError", withCause(err, key), key);
    }
    if (!response.ok) throw await toError(response, key);

    return {
      exists: true,
      size: Number(response.headers.get("content-length") ?? 0),
      contentType: response.headers.get("content-type"),
      // Read, never trusted. See `put`.
      etag: response.headers.get("etag"),
      sha256: response.headers.get("x-amz-meta-sha256")
    };
  }

  async function remove(key) {
    const headers = await signedHeaders({
      method: "DELETE",
      path: `/${config.minio.bucket}/${encodeKey(key)}`,
      payloadHash: EMPTY_PAYLOAD_HASH
    });
    const response = await fetchImpl(urlFor(key), { method: "DELETE", headers });
    // 204 is the success. A 404 means it is already gone, which for a delete is
    // the state the caller asked for.
    if (!response.ok && response.status !== 404) throw await toError(response, key);
    return true;
  }

  /** List keys under a prefix. */
  async function list(prefix = "", { limit = 1000 } = {}) {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix,
      "max-keys": String(limit)
    });

    const headers = await signedHeaders({
      method: "GET",
      path: `/${config.minio.bucket}`,
      payloadHash: EMPTY_PAYLOAD_HASH,
      canonicalQuery: query
    });

    const response = await fetchImpl(
      `${endpoint.replace(/\/+$/, "")}/${config.minio.bucket}?${query}`,
      { method: "GET", headers }
    );
    if (!response.ok) throw await toError(response, prefix);

    const xml = await response.text();
    return {
      keys: [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]),
      truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml)
    };
  }

  /**
   * Sign a request.
   *
   * Exported through the client so the signature can be asserted against a value
   * computed by hand from the specification. A SigV4 implementation that is
   * subtly wrong produces a 403 from the service, which looks like a
   * credentials problem and sends the reader looking in the wrong place.
   */
  async function signedHeaders({ method, path, payloadHash, contentType, contentLength, canonicalQuery, extra = {} }) {
    if (!config.minio.accessKey || !config.minio.secretKey) {
      throw new Error(
        "No S3 credentials. Set MINIO_ROOT_USER and MINIO_ROOT_PASSWORD " +
          "(or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)."
      );
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

    const query = canonicalQuery
      ? [...canonicalQuery.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
      : [];

    const headersToSign = {
      host: signingHost,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extra
    };
    if (contentType) headersToSign["content-type"] = contentType;

    const signedHeaderNames = Object.keys(headersToSign).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders =
      signedHeaderNames.map((name) => {
        const key = Object.keys(headersToSign).find((h) => h.toLowerCase() === name);
        return `${name}:${String(headersToSign[key]).trim()}\n`;
      }).join("");

    const canonicalRequest = [
      method,
      path,
      query.map(([k, v]) => `${k}=${v}`).join("&"),
      canonicalHeaders,
      signedHeaderNames.join(";"),
      payloadHash
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");

    // The four-step key derivation, one HMAC at a time.
    //
    // Written as a fold over an array because that is the shape the
    // specification describes. The first version wrote it as a single chained
    // expression, which compiles and then throws `.update is not a function` on
    // the first request: `reduce` already ran `.digest()`, so the accumulator
    // is a Buffer and Buffers have no `update`.
    const signingKey = [
      `AWS4${config.minio.secretKey}`,
      dateStamp,
      region,
      "s3",
      "aws4_request"
    ].reduce((key, part) => createHmac("sha256", key).update(part).digest());

    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const out = {
      ...headersToSign,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.minio.accessKey}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`
    };
    if (contentLength !== undefined) out["content-length"] = String(contentLength);
    return out;
  }

  /** The real reason behind a `fetch failed`. */
  function withCause(err, key) {
    const cause = err?.cause;
    const detail = cause
      ? [cause.code, cause.message].filter(Boolean).join(": ")
      : err.message;
    return `could not reach the object store at ${endpoint} for ${key} — ${detail}`;
  }

  async function toError(response, key) {
    let code = null;
    let message = response.statusText || "request failed";
    try {
      const xml = await response.text();
      code = xml.match(/<Code>([^<]*)<\/Code>/)?.[1] ?? null;
      message = xml.match(/<Message>([^<]*)<\/Message>/)?.[1] ?? message;
    } catch {
      // A body that cannot be read is not the interesting part of the failure.
    }
    return new S3Error(response.status, code, message, key);
  }

  return { put, get, head, remove, list, signedHeaders, bucket: config.minio.bucket, endpoint };
}

/** S3 keys are URL paths, not query strings. Slashes are structure. */
function encodeKey(key) {
  return String(key)
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new TypeError(`S3 body must be a Buffer, Uint8Array or string, got ${typeof body}`);
}

/** Metadata becomes `x-amz-meta-*`, which is how the sha256 travels with the bytes. */
function metadataHeaders(metadata) {
  const out = {};
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (value === undefined || value === null) continue;
    out[`x-amz-meta-${String(name).toLowerCase()}`] = String(value);
  }
  return out;
}

export { createHash as sha256, EMPTY_PAYLOAD_HASH };
