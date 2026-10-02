import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

import { createS3Client, S3Error } from "../src/media/s3.mjs";
import { extractPdfText, isPdf } from "../src/media/pdf.mjs";
import { createMediaIngestor, sniffContentType, sniffFromBytes } from "../src/media/ingest.mjs";
import { loadConfig } from "../src/config.mjs";

/**
 * Media, with no object store and no network.
 *
 * The S3 client and the PDF extractor are both testable without MinIO, and they
 * are the two places where a wrong answer is *plausible* rather than loud: a
 * signature that omits the port, or an extraction that returns an empty string
 * and looks like a document with no words.
 *
 * The integration suite (`npm run media:verify`) is what proves the signing
 * works against a real MinIO. What is pinned here is everything that can be
 * wrong without a service being available.
 */

const config = loadConfig({
  ...process.env,
  POSTGRES_PASSWORD: "unused",
  OPENROUTER_API_KEY: "",
  HOME: "/nonexistent-jove-test-home",
  JOVE_SECRETS_DIR: undefined,
  OPENROUTER_API_KEY_FILE: undefined,
  MINIO_ENDPOINT: "minio",
  MINIO_PORT: "9000",
  MINIO_ROOT_USER: "testuser",
  MINIO_ROOT_PASSWORD: "testpass",
  MINIO_BUCKET: "test-bucket"
});

// ---------------------------------------------------------------------------
// Fixtures, generated
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makePng(size = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(size * (size * 3 + 1)), { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function makePdf(lines, { compress = true } = {}) {
  const content =
    `BT\n/F1 14 Tf\n72 720 Td\n16 TL\n` +
    lines.map((l) => `(${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`).join("\n") +
    `\nET`;

  const body = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n${body.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PNG = makePng();
const PDF = makePdf(["INVOICE 2026-03-14 from ACME LEGAL", "Total due: R$ 4.820,00"]);

// ---------------------------------------------------------------------------
// S3: the signing
// ---------------------------------------------------------------------------

/** Records the request and answers with a canned response. */
function fakeS3({ status = 200, body = null, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    // Headers normalised to lowercase, as the real `fetch` does. Without this
    // the fake is more permissive than the thing it stands in for, and a
    // signature assertion written against it passes while the real client
    // sends a header the server never saw.
    const normalised = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    calls.push({ url, method: init.method, headers: normalised, body: init.body });
    return new Response(body ?? "", { status, headers });
  };
  return { impl, calls };
}

test("a PUT is signed with AWS4-HMAC-SHA256 and includes the port in the host", async () => {
  // The port matters and its absence is invisible: `new URL('http://minio').host`
  // is `minio`, and a signature over a host that differs from the one connected
  // to produces a 403 on a request that is otherwise correct — which reads as a
  // credentials problem and sends the reader to the wrong place entirely.
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  await s3.put("ws/ab/file.png", PNG, { contentType: "image/png" });

  const auth = transport.calls[0].headers.authorization;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=testuser\/\d{8}\/us-east-1\/s3\/aws4_request/);
  assert.match(auth, /SignedHeaders=[^,]*host/);
  assert.equal(transport.calls[0].headers.host, "minio:9000");
});

test("the content hash is signed, not just the header name", async () => {
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  await s3.put("k", "hello", { contentType: "text/plain" });

  const expected = createHash("sha256").update("hello").digest("hex");
  assert.equal(transport.calls[0].headers["x-amz-content-sha256"], expected);
});

test("an empty body is signed with the hash of the empty string", async () => {
  // The specification requires that exact constant, and a GET or DELETE has no
  // payload to hash.
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  await s3.list("");
  assert.equal(
    transport.calls[0].headers["x-amz-content-sha256"],
    createHash("sha256").update("").digest("hex")
  );
});

test("the signature covers the content type, so changing it changes the signature", async () => {
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  await s3.put("k", "x", { contentType: "text/plain" });
  await s3.put("k", "x", { contentType: "application/json" });

  const signed = (call) => call.headers.authorization.match(/Signature=([0-9a-f]+)/)[1];
  assert.notEqual(signed(transport.calls[0]), signed(transport.calls[1]));
});

test("keys are URL-encoded per path segment, and slashes stay structure", () => {
  // S3 keys are paths, not query strings. Encoding the slashes turns one
  // object into a single key with literal percent signs in its name.
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  return s3.put("ws/ab/a b+c.txt", "x").then(() => {
    assert.match(transport.calls[0].url, /\/ws\/ab\/a%20b%2Bc\.txt$/);
  });
});

test("the sha256 travels with the bytes as object metadata", async () => {
  // So a read can verify without consulting the database first.
  const transport = fakeS3();
  const s3 = createS3Client({ config, fetch: transport.impl });

  const result = await s3.put("k", PNG, { contentType: "image/png", metadata: { sha256: "abc", filename: "x.png" } });

  assert.equal(transport.calls[0].headers["x-amz-meta-sha256"], "abc");
  assert.equal(transport.calls[0].headers["x-amz-meta-filename"], "x.png");
  assert.equal(result.sha256, createHash("sha256").update(PNG).digest("hex"));
});

test("the returned ETag is reported but never as the integrity proof", async () => {
  const transport = fakeS3({ headers: { etag: '"abc123-4"' } });
  const s3 = createS3Client({ config, fetch: transport.impl });

  const result = await s3.put("k", PNG);

  // A multipart ETag looks like a hash and is not one. Verification is by
  // sha256, and the ETag is carried because a changed ETag with an unchanged
  // hash is a useful signal — as long as nothing treats it as the authority.
  assert.equal(result.etag, '"abc123-4"');
  assert.equal(result.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.notEqual(result.sha256, result.etag);
});

test("reading verifies the sha256 and refuses a mismatch", async () => {
  const stored = createHash("sha256").update("good").digest("hex");
  const transport = fakeS3({
    body: Buffer.from("tampered"),
    headers: { "x-amz-meta-sha256": stored, etag: '"deadbeef"' }
  });
  const s3 = createS3Client({ config, fetch: transport.impl });

  await assert.rejects(
    () => s3.get("k"),
    (err) => {
      assert.ok(err instanceof S3Error);
      assert.equal(err.code, "IntegrityMismatch");
      assert.match(err.message, /does not match its recorded sha256/);
      return true;
    }
  );
});

test("verification can be turned off, and the bytes still differ", async () => {
  // The point of the check: `verify: false` is a choice with a visible
  // consequence, not a different answer.
  const transport = fakeS3({ body: Buffer.from("tampered"), headers: { "x-amz-meta-sha256": "abc" } });
  const s3 = createS3Client({ config, fetch: transport.impl });

  const object = await s3.get("k", { verify: false });
  assert.equal(object.body.toString(), "tampered");
  assert.equal(object.sha256, createHash("sha256").update("tampered").digest("hex"));
  assert.equal(object.etag, null, "and nothing about the ETag was consulted");
});

test("a network failure names the endpoint and the cause", async () => {
  // `fetch failed` alone is useless. The cause carries the DNS failure or the
  // refused connection, and reporting only the wrapper turns a configuration
  // problem into a mystery.
  const impl = async () => {
    const err = new TypeError("fetch failed");
    err.cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:9000"), { code: "ECONNREFUSED" });
    throw err;
  };
  const s3 = createS3Client({ config, fetch: impl });

  await assert.rejects(
    () => s3.put("k", "x"),
    (err) => {
      assert.equal(err.code, "NetworkError");
      assert.match(err.message, /ECONNREFUSED/);
      assert.match(err.message, /minio:9000/);
      return true;
    }
  );
});

test("no credentials is refused before a request is made", async () => {
  const transport = fakeS3();
  const s3 = createS3Client({
    config: { ...config, minio: { ...config.minio, accessKey: "", secretKey: "" } },
    fetch: transport.impl
  });

  await assert.rejects(() => s3.put("k", "x"), /No S3 credentials/);
  assert.equal(transport.calls.length, 0);
});

test("an S3 error body is parsed into a code and a message", async () => {
  const transport = fakeS3({
    status: 404,
    body: "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>"
  });
  const s3 = createS3Client({ config, fetch: transport.impl });

  await assert.rejects(
    () => s3.get("missing"),
    (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.code, "NoSuchKey");
      assert.match(err.message, /does not exist/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

test("a compressed PDF's text is extracted", () => {
  const result = extractPdfText(PDF);
  assert.match(result.text, /INVOICE/);
  assert.match(result.text, /4\.820/);
  assert.equal(result.reason, null);
  assert.equal(result.method, "flate+operators");
});

test("an uncompressed PDF's text is extracted too", () => {
  const result = extractPdfText(makePdf(["PLAIN CONTENT HERE"], { compress: false }));
  assert.match(result.text, /PLAIN CONTENT HERE/);
  assert.equal(result.method, "operators");
});

test("a file that is not a PDF is refused by its magic, not its name", () => {
  // The property that catches a text file renamed .pdf.
  const result = extractPdfText(Buffer.from("just some text"));
  assert.equal(result.text, "");
  assert.match(result.reason, /not a PDF/);
  assert.equal(isPdf(Buffer.from("just some text")), false);
});

test("a PDF with no content streams says so, rather than extracting nothing", () => {
  // A scanned document has no text layer. Said plainly, because a media record
  // with empty text and no reason is indistinguishable from one that was
  // indexed — and it retrieves nothing while reporting full coverage.
  const scanned = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "latin1");
  const result = extractPdfText(scanned);
  assert.equal(result.text, "");
  assert.match(result.reason, /scanned PDF with no text layer/);
});

test("a stream that claims FlateDecode and is not does not abort the extraction", async () => {
  const broken = Buffer.from(
    "%PDF-1.4\n<< /Filter /FlateDecode /Length 99 >>\nstream\nnot deflate at all\nendstream\n%%EOF",
    "latin1"
  );
  const result = extractPdfText(broken);
  // Continuing past it is the point: a hand-edited PDF with one bad stream
  // should still yield whatever the other streams contain.
  assert.equal(result.text, "");
  assert.ok(result.reason, "and the failure is still reported");
});

test("a TJ array's elements are read, and escaped characters are decoded", () => {
  const pdf = makePdf(["(INVOICE \\(2026\\))"], { compress: false });
  const result = extractPdfText(pdf);
  assert.match(result.text, /INVOICE/);
  assert.match(result.text, /2026/);
});

test("non-string stream filters are skipped, not misread as text", () => {
  // A DCTDecode stream is a JPEG. Reading it as text produces the binary of an
  // image, indexed as if it were words.
  const pdf = Buffer.from(
    "%PDF-1.4\n<< /Filter /DCTDecode /Length 40 >>\nstream\nÿØÿà   binary image data hereÿÿá\nendstream\n%%EOF",
    "latin1"
  );
  const result = extractPdfText(pdf);
  assert.equal(result.text, "");
});

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

test("the type comes from the bytes, and the source says which", () => {
  assert.equal(isPdf(PDF), true);
  assert.deepEqual(sniffFromBytes(PNG), "image/png");

  assert.deepEqual(sniffContentType(PDF, "invoice.png", "image/png"), {
    contentType: "application/pdf",
    source: "sniffed"
  });
});

test("a type is never reported as sniffed when it came from a name or a claim", () => {
  // The field whose whole job is to say where a type came from. The first
  // version recorded `sniffed` for a type it had read off the filename, and a
  // text file named .pdf became a "sniffed" PDF.
  const fromName = sniffContentType(Buffer.from("plain"), "lies.pdf", null);
  assert.equal(fromName.source, "extension");

  const fromClaim = sniffContentType(Buffer.from("plain"), "notes.qqq", "text/plain");
  assert.equal(fromClaim.source, "declared");

  const unknown = sniffContentType(Buffer.from("plain"), "blob", null);
  assert.deepEqual(unknown, { contentType: "application/octet-stream", source: "unknown" });
});

test("unrecognised bytes are not sniffed, so a renamed file keeps its name's claim", () => {
  assert.equal(sniffFromBytes(Buffer.from("just text")), null);
});

// ---------------------------------------------------------------------------
// The ingestor, against a fake store and a fake S3
// ---------------------------------------------------------------------------

function fakeStore() {
  const rows = new Map();
  const mutations = [];
  return {
    rows,
    mutations,
    workspaceName: "test",
    async findMediaByHash(hash) {
      return rows.get(hash) ?? null;
    },
    async upsertMedia(media) {
      const row = {
        id: media.id,
        content_type: media.contentType,
        content_type_source: media.contentTypeSource,
        size_bytes: media.sizeBytes,
        extracted_text: media.extractedText,
        extraction_method: media.extractionMethod,
        extraction_error: media.extractionError,
        sha256: media.sha256,
        etag: media.etag,
        item_id: media.itemId,
        object_key: media.objectKey
      };
      rows.set(media.sha256, row);
      return row;
    },
    async readMedia(id) {
      return [...rows.values()].find((r) => r.id === id) ?? null;
    },
    async attachMediaToItem(id, itemId) {
      const row = [...rows.values()].find((r) => r.id === id);
      if (row) row.item_id = itemId;
      return row ?? null;
    },
    async recordMediaMutation(m) {
      mutations.push(m);
    },
    async listMedia({ limit = 100 } = {}) {
      return [...rows.values()].slice(0, limit);
    }
  };
}

function fakeS3Ok(transport = fakeS3({ headers: { etag: '"etag-1"' } })) {
  const s3 = createS3Client({ config, fetch: transport.impl });
  return { s3, transport };
}

test("a media id is the sha256 of the bytes", async () => {
  const store = fakeStore();
  const { s3 } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  const result = await ingestor.ingest({ bytes: PNG, filename: "a.png" });

  assert.equal(result.ok, true);
  assert.equal(result.id, createHash("sha256").update(PNG).digest("hex"));
  assert.equal(result.sizeBytes, PNG.length);
});

test("identical bytes are stored once", async () => {
  // Content addressing makes deduplication a property of the schema rather
  // than a cleanup job, and it also means a caller cannot invent an id and
  // overwrite someone else's file.
  const store = fakeStore();
  const { s3, transport } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  await ingestor.ingest({ bytes: PNG, filename: "first.png" });
  const again = await ingestor.ingest({ bytes: PNG, filename: "second.png" });

  assert.equal(again.deduplicated, true);
  assert.equal(store.rows.size, 1);
  assert.equal(transport.calls.length, 1, "and uploaded once");
});

test("a repeated upload returns the same shape as the first", async () => {
  // A caller reading `result.contentType` must not get `undefined` on every
  // repeat upload — which is exactly the upload a test suite runs twice, and
  // exactly the upload a retry produces.
  const store = fakeStore();
  const { s3 } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  const first = await ingestor.ingest({ bytes: PNG, filename: "a.png" });
  const second = await ingestor.ingest({ bytes: PNG, filename: "a.png" });

  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
  assert.equal(second.contentType, first.contentType);
  assert.equal(second.contentTypeSource, first.contentTypeSource);
});

test("a failed upload records nothing", async () => {
  // The order is verify, upload, then record. A record pointing at bytes that
  // are not there is a record that retrieves nothing.
  const store = fakeStore();
  const transport = fakeS3({ status: 500, body: "<Error><Code>InternalError</Code></Error>" });
  const s3 = createS3Client({ config, fetch: transport.impl });
  const ingestor = createMediaIngestor({ store, s3 });

  const result = await ingestor.ingest({ bytes: PNG, filename: "a.png" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "upload_failed");
  assert.equal(store.rows.size, 0, "no dangling record");
});

test("empty bytes are refused before any work", async () => {
  const store = fakeStore();
  const { s3, transport } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  for (const bytes of [Buffer.alloc(0), null, "a string"]) {
    const result = await ingestor.ingest({ bytes });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
  }
  assert.equal(transport.calls.length, 0);
});

test("a PDF's extracted text is stored, and a failure to extract is recorded", async () => {
  const store = fakeStore();
  const { s3 } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  const good = await ingestor.ingest({ bytes: PDF, filename: "invoice.pdf" });
  assert.match(good.extractionMethod, /flate/);
  assert.equal(good.extracted, true);
  assert.equal(good.extractionError, null);

  // A file that claims PDF but has no content streams: stored, with a reason.
  const fake = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "latin1");
  const poor = await ingestor.ingest({ bytes: fake, filename: "scanned.pdf" });
  assert.equal(poor.ok, true, "a scanned document is still a document the user chose to keep");
  assert.match(poor.extractionError, /no text layer/);
});

test("an image with no describer keeps its caption and says why", async () => {
  // The honest minimum. A fabricated description would be worse than none.
  const store = fakeStore();
  const { s3 } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  const withCaption = await ingestor.ingest({ bytes: PNG, filename: "a.png", caption: "a red square" });
  assert.equal(withCaption.extracted, true);
  assert.equal(withCaption.extractionMethod, "caption-only");
  assert.match(withCaption.extractionError, /only the caption is searchable/);

  const without = await ingestor.ingest({ bytes: makePng(16), filename: "b.png" });
  assert.equal(without.extracted, false);
  assert.match(without.extractionError, /no describer configured and no caption/);
});

test("a describer's failure falls back to the caption rather than failing the upload", async () => {
  const store = fakeStore();
  const { s3 } = fakeS3Ok();
  const ingestor = createMediaIngestor({
    store,
    s3,
    describer: async () => {
      throw new Error("vision model unavailable");
    }
  });

  const result = await ingestor.ingest({ bytes: PNG, filename: "a.png", caption: "a red square" });

  assert.equal(result.ok, true);
  assert.equal(result.extracted, true, "the caption is still there");
  assert.match(result.extractionError, /describer failed/);
});

test("object keys are sharded and stable", () => {
  // A bucket with one flat prefix is a bucket where every listing is a full
  // scan. Stability means a re-upload is a no-op rather than a second copy.
  const store = fakeStore();
  const { s3, transport } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  const sha = createHash("sha256").update(PNG).digest("hex");
  return ingestor.ingest({ bytes: PNG, filename: "photo.png" }).then(() => {
    assert.match(transport.calls[0].url, /\/test\/[0-9a-f]{2}\/[0-9a-f]{64}-photo\.png$/);
    assert.ok(transport.calls[0].url.includes(sha.slice(0, 2)), "sharded by hash prefix");
  });
});

test("a filename is sanitised into the key", async () => {
  // A filename with a slash in it would otherwise create a nested key that
  // does not correspond to anything.
  const store = fakeStore();
  const { s3, transport } = fakeS3Ok();
  const ingestor = createMediaIngestor({ store, s3 });

  await ingestor.ingest({ bytes: makePng(12), filename: "../../etc/passwd.png" });
  const key = new URL(transport.calls[0].url).pathname;

  // A traversal segment in a key is a key that sorts and lists as a
  // directory, and one that could escape a prefix-scoped IAM policy.
  assert.equal(key.includes(".."), false);
  assert.equal(key.includes("etc/passwd"), false);
  assert.match(key, /-[a-zA-Z0-9.-]+\.png$/, "and the sanitised name is still there");
});
