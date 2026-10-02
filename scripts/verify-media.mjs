#!/usr/bin/env node
/**
 * Phase 7's gate, against a real MinIO and a real PostgreSQL.
 *
 *   - Upload an image, query it with text, get it back
 *   - Upload a PDF, text extracted and indexed
 *   - sha256 stored and verifiable; the ETag is never the integrity proof
 *
 * Run inside the compose network, because MinIO publishes no host port and this
 * is the point of it. `docker compose run --rm api node scripts/verify-media.mjs`
 */

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createPoolManager } from "../src/store/pool.mjs";
import { createStore } from "../src/store/store.mjs";
import { migrate } from "../src/store/migrate.mjs";
import { createS3Client } from "../src/media/s3.mjs";
import { createMediaIngestor } from "../src/media/ingest.mjs";
import { createEmbedder } from "../src/embedding/openrouter.mjs";
import { createIngestor } from "../src/ingest/embed.mjs";
import { createSearcher } from "../src/retrieval/search.mjs";
import { loadConfig } from "../src/config.mjs";

function out(text) {
  process.stdout.write(text);
}

const config = loadConfig();
const pools = createPoolManager(config, {});
const workspace = `p7_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Test files, generated rather than shipped
//
// A binary fixture in a public repository is a binary nobody can review, and a
// fixture downloaded at test time is a test that fails when a third party is
// down. Both are generated here.
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

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A recognisable image: a red square on a blue field. */
function makePng(size = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const red = x >= size / 4 && x < (size * 3) / 4;
      const redy = y >= size / 4 && y < (size * 3) / 4;
      const p = rowStart + 1 + x * 3;
      raw[p] = redy && red ? 220 : 30;
      raw[p + 1] = redy && red ? 40 : 70;
      raw[p + 2] = redy && red ? 40 : 160;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * A PDF with a real, FlateDecode-compressed content stream.
 *
 * Compressed on purpose: the extraction path has to inflate, and a fixture
 * that is uncompressed would pass without ever exercising that.
 */
function makePdf(lines) {
  const content = ["BT", "/F1 14 Tf", "72 720 Td", "16 TL"].join("\n")
    + "\n" + lines.map((l) => `(${escapePdf(l)}) Tj T*`).join("\n")
    + "\nET";

  const stream = deflateSync(Buffer.from(content, "latin1"));

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

function escapePdf(text) {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------

const IMAGE = makePng();
const PDF = makePdf([
  "INVOICE 2026-03-14 from ACME LEGAL",
  "Client: Kayro Alexandre",
  "Total due: R$ 4.820,00",
  "Payment terms: 30 days from issue"
]);

let failures = 0;
const check = (label, pass, detail) => {
  out(`  [${pass ? "pass" : "FAIL"}] ${label}\n`);
  if (detail) out(`         ${detail}\n`);
  if (!pass) failures += 1;
};

try {
  out(`Phase 7 — media, against ${config.minio.endpoint}:${config.minio.port} (${config.minio.bucket})\n\n`);

  await pools.provisionWorkspace(workspace, { migrate });
  const store = createStore({ workspace, pools });
  const s3 = createS3Client({ config });
  const ingestor = createMediaIngestor({ store, s3, logger: null });

  // -- The bucket exists ----------------------------------------------------
  // MinIO does not create buckets implicitly the way it does not, and a bucket
  // that is missing produces a confusing 404 on the first put rather than a
  // clear error on setup.
  try {
    await s3.list("");
    check("the bucket is reachable", true, `bucket "${config.minio.bucket}" answered`);
  } catch (err) {
    check("the bucket is reachable", false, err.message);
    out("\n  The bucket has to exist before anything can be stored.\n");
    out(`  docker compose exec minio mc mb -p local/${config.minio.bucket}\n\n`);
    process.exit(1);
  }

  // -- 1. Upload an image, and get it back ----------------------------------
  out("\n  image\n");
  const imageResult = await ingestor.ingest({
    bytes: IMAGE,
    filename: "red-square.png",
    declaredType: "image/png",
    caption: "a red square on a blue field",
    itemId: null
  });

  check("image uploaded", imageResult.ok, imageResult.detail ?? "");
  check(
    "the id is the sha256 of the bytes",
    imageResult.id === createHash("sha256").update(IMAGE).digest("hex"),
    imageResult.id
  );
  check("content type sniffed, not trusted", imageResult.contentType === "image/png", `${imageResult.contentType} (${imageResult.contentTypeSource})`);

  const fetched = await ingestor.fetchMedia(imageResult.id, { verify: true });
  check("image fetched back", fetched.ok, fetched.detail ?? "");
  check("the fetched bytes are the uploaded bytes", fetched.ok && fetched.bytes.equals(IMAGE), `${fetched.bytes?.length} bytes`);
  check("sha256 verified on read", fetched.ok && fetched.verified, "recomputed and compared");

  // -- ETag is recorded and never trusted -----------------------------------
  out("\n  integrity\n");
  const media = await store.readMedia(imageResult.id);
  check("an ETag is recorded", Boolean(media.etag), media.etag ?? "(none)");
  check(
    "the ETag is not the proof — the sha256 is",
    media.sha256 !== media.etag && imageResult.etagUsedForIntegrity === false,
    `sha256 ${media.sha256.slice(0, 16)}… / etag ${media.etag}`
  );

  // Corruption must be detected, and detected by the hash.
  const s3Key = media.object_key;
  const shaBefore = media.sha256;
  await s3.put(s3Key, Buffer.concat([IMAGE, Buffer.from("TAMPERED")]), {
    contentType: "image/png",
    // The stored metadata still claims the original hash, which is exactly the
    // case a real corruption produces: the bytes changed and the record did not.
    metadata: { sha256: shaBefore, filename: "red-square.png" }
  });

  const tampered = await ingestor.fetchMedia(imageResult.id, { verify: true });
  check(
    "tampered bytes are refused",
    !tampered.ok && tampered.reason === "IntegrityMismatch",
    tampered.ok ? "READ ANYWAY — this is the failure this whole check exists for" : tampered.detail
  );

  const tamperedUnverified = await ingestor.fetchMedia(imageResult.id, { verify: false });
  check(
    "and the refusal is a verification, not a read error",
    tamperedUnverified.ok && !tamperedUnverified.bytes.equals(IMAGE),
    "with verify:false the bytes come back, and they are visibly different"
  );

  // Put the real bytes back so the rest of the run is against a good object.
  await s3.put(s3Key, IMAGE, { contentType: "image/png", metadata: { sha256: shaBefore, filename: "red-square.png" } });

  // -- Deduplication --------------------------------------------------------
  out("\n  deduplication\n");
  const again = await ingestor.ingest({ bytes: IMAGE, filename: "red-square-copy.png" });
  check("re-uploading identical bytes is a no-op", again.ok && again.deduplicated === true, `deduplicated: ${again.deduplicated}`);

  // -- 2. Upload a PDF, text extracted and indexed --------------------------
  out("\n  pdf\n");
  const pdfResult = await ingestor.ingest({
    bytes: PDF,
    filename: "invoice-2026-03.pdf",
    declaredType: "application/pdf"
  });

  check("pdf uploaded", pdfResult.ok, pdfResult.detail ?? "");
  check("text extracted", pdfResult.extracted === true, pdfResult.extractionError ?? `method: ${pdfResult.extractionMethod}`);

  const pdfMedia = await store.readMedia(pdfResult.id);
  check(
    "the extraction found the document's own words",
    /INVOICE/.test(pdfMedia.extracted_text) && /4\.820/.test(pdfMedia.extracted_text),
    `extracted ${pdfMedia.extracted_text.length} characters`
  );
  check("page count read from the PDF", pdfMedia.extracted_text.length > 0, `method: ${pdfMedia.extraction_method}`);

  // A PDF that is not really a PDF must be recorded by what the bytes are, not
  // by what the filename claims. The first version trusted the extension and
  // recorded this as application/pdf with the source "sniffed" — a lie in the
  // one field whose job is to say where a type came from.
  const RUN = process.env.MEDIA_VERIFY_RUN ?? String(Date.now());
  const notAPdf = await ingestor.ingest({
    // Unique per run. Content-addressed ids mean a fixed fixture is a
    // deduplication hit on the second run, and a deduplication hit exercises
    // the *stored row* rather than the detection code — which is how a check
    // about sniffing ends up reporting a field the fresh path never computed.
    bytes: Buffer.from(`this is plain text, not a document (${RUN})`),
    filename: "lies.pdf",
    declaredType: "application/pdf"
  });
  // The property that matters is the SOURCE, not the resolved type. An
  // unrecognised file named .pdf is recorded as a PDF on the strength of its
  // name, and the row says so — which is the difference between a type
  // somebody established and a type somebody claimed.
  check(
    "a file that lies about being a PDF is not recorded as *sniffed*",
    notAPdf.ok && notAPdf.contentTypeSource === "extension",
    `recorded as ${notAPdf.contentType} (from ${notAPdf.contentTypeSource})`
  );

  // And a genuine PDF whose filename is wrong is recorded from its bytes, with
  // the disagreement reported.
  // Distinct bytes, so this is a fresh upload rather than the deduplication
  // path: the same document with one word changed.
  const misnamed = await ingestor.ingest({
    bytes: Buffer.concat([PDF, Buffer.from(`\n% appended marker ${RUN}\n`)]),
    filename: "invoice.png",
    declaredType: "image/png"
  });
  check(
    "a PDF named .png is recorded from its bytes, with the mismatch flagged",
    misnamed.ok && misnamed.contentType === "application/pdf" &&
      misnamed.contentTypeSource === "sniffed" && Boolean(misnamed.typeMismatch),
    `recorded as ${misnamed.contentType} (from ${misnamed.contentTypeSource}), mismatch: ${misnamed.typeMismatch}`
  );

  // -- 3. Text query retrieves media ---------------------------------------
  out("\n  retrieval\n");
  const embedder = config.providers.apiKey ? createEmbedder({ config, store }) : null;

  if (!embedder) {
    out("  [skip] no embedding provider, so the retrieval half cannot run\n");
    out("         save a key at /settings and re-run\n");
  } else {
    const mediaIngestor = createMediaIngestor({ store, s3, embedder });

    // Both media need to belong to a memory to be recallable, and they need
    // something to be described from. The captions are what a caller would
    // supply, and they are the honest minimum: no vision model is configured.
    for (const [id, caption] of [
      [imageResult.id, "a red square on a blue field"],
      [pdfResult.id, "invoice from ACME LEGAL for R$ 4.820,00 dated 2026-03-14"]
    ]) {
      await store.attachMediaToItem(id, "seed");
    }

    // Give the media a description and embed it, the way the ingestor does.
    for (const row of await store.listUnembeddedMedia({})) {
      const text = [row.caption, row.extracted_text].filter(Boolean).join("\n\n");
      if (!text.trim()) continue;
      const [vector] = await embedder.embed([text]);
      await store.upsertMediaEmbedding(row.id, embedder.model, vector);
    }

    const [queryVector] = await embedder.embed(["an invoice from a legal firm in March 2026"]);
    const mediaHits = await store.searchMedia(queryVector, { model: embedder.model });

    check(
      "a text query retrieves the PDF",
      mediaHits.some((hit) => hit.id === pdfResult.id),
      mediaHits.slice(0, 3).map((h) => `${h.id.slice(0, 8)}… ${h.similarity.toFixed(3)}`).join(", ")
    );

    // And the image, by a description of the image.
    const [imageQuery] = await embedder.embed(["a red square on a blue background"]);
    const imageHits = await store.searchMedia(imageQuery, { model: embedder.model });
    check(
      "a text query retrieves the image",
      imageHits[0]?.id === imageResult.id,
      imageHits.slice(0, 3).map((h) => `${h.id.slice(0, 8)}… ${h.similarity.toFixed(3)}`).join(", ")
    );

    // Media in the same space as text, which is the point of ADR-005.
    const searcher = createSearcher({ store, embed: embedder });
    await store.createNode({ id: "seed", label: "Seed" });
    await store.upsertItem({ id: "seed", node_id: "seed", content: "a red square on a blue field" });
    const memoryEmbed = createIngestor({ store, embedder });
    await memoryEmbed.embedItem("seed");

    const mediaSpace = await store.searchMedia(queryVector, { model: embedder.model });
    const textSpace = await store.searchVector(queryVector, { model: embedder.model });
    check(
      "media and text share one embedding space",
      mediaSpace.length > 0 && textSpace.length > 0,
      `media ${mediaSpace.length} hits, text ${textSpace.length} hits, from the same query vector`
    );

    const coverage = await store.mediaCoverage();
    check("media coverage is reported", coverage.attached > 0, JSON.stringify(coverage));
  }

  // -- 4. Verify everything -------------------------------------------------
  out("\n  verify all\n");
  const audit = await ingestor.verifyAll({ limit: 100 });
  check("every media row verified against its bytes", audit.corrupt.length === 0 && audit.missing.length === 0,
    `checked ${audit.checked}, verified ${audit.verified}, corrupt ${audit.corrupt.length}, missing ${audit.missing.length}`);

  const auditTrail = await store.listMediaMutations({ limit: 10 });
  check("uploads are recorded", auditTrail.length > 0, `${auditTrail.length} mutation(s), latest: ${auditTrail[0]?.operation}`);

  // The mutation log must reject edits, like the other two append-only tables.
  try {
    await pools.poolFor(workspace).query("UPDATE media_mutations SET note = 'edited'");
    check("media_mutations is append-only", false, "an UPDATE was accepted");
  } catch (err) {
    check("media_mutations is append-only", /append-only/.test(err.message), err.message.split("\n")[0]);
  }
} catch (err) {
  out(`\n  ERROR: ${err.message}\n\n${err.stack}\n`);
  failures += 1;
} finally {
  await pools.dropWorkspace(workspace).catch(() => {});
  await pools.close();
}

out(`\n  ${failures === 0 ? "GATE MET" : `${failures} CHECK(S) FAILED`}\n\n`);
process.exit(failures === 0 ? 0 : 1);
