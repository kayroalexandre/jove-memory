#!/usr/bin/env node
/**
 * Verify the stored key against the live OpenRouter API, and close the one
 * Phase 4 gate item that could not be closed without it.
 *
 * What this does:
 *
 *   1. One text embedding. Checks the width is the one the column expects —
 *      the property every later write depends on.
 *   2. One image embedding, from a PNG generated here rather than fetched
 *      from anywhere. Nothing leaves the machine except the bytes of a
 *      32×32 greyscale square.
 *   3. The cross-modal comparison, which is the gate: does an image land
 *      nearer the text describing it than to unrelated text? That is a fact
 *      about Google's embedding space, and it is the one thing a fake
 *      embedder could never establish.
 *
 * It costs a fraction of a cent. It says so before running.
 *
 * What it never does: print the key, print any part of it, or write it
 * anywhere.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmbedder } from "../src/embedding/openrouter.mjs";
import { loadConfig } from "../src/config.mjs";

// ---------------------------------------------------------------------------
// A PNG, generated rather than downloaded
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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A 32×32 greyscale image: a bright square on a dark field.
 *
 * Chosen because it is describable in one sentence and unlike anything
 * financial. The comparison is text-that-describes-this against
 * text-unrelated-to-this, and the image has to have an obvious nearest
 * neighbour or the cross-modal test is measuring noise.
 */
function makePng(size = 32) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte per scanline (0 = None), then the pixels.
  const raw = Buffer.alloc(size * (size + 1));
  const inset = Math.floor(size / 4);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const inSquare = x >= inset && x < size - inset && y >= inset && y < size - inset;
      raw[rowStart + 1 + x] = inSquare ? 235 : 24;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------

function out(text) {
  process.stdout.write(text);
}

const config = loadConfig();

if (!config.providers.apiKey) {
  out(
    "No provider key found.\n\n" +
      "  Looked for, in order:\n" +
      "    1. OPENROUTER_API_KEY in the environment\n" +
      "    2. OPENROUTER_API_KEY_FILE, or ~/.config/jove-memory/openrouter.key\n" +
      "    3. /run/secrets/openrouter_api_key\n\n" +
      "  Store one with:  npm run key:set\n"
  );
  process.exit(1);
}

out(
  `Checking ${config.providers.embedModel} against the live API.\n` +
    `  This makes two requests and costs a fraction of a cent.\n` +
    `  The key is never printed.\n\n`
);

const embedder = createEmbedder({ config, logger: null });

// -- 1. Text -----------------------------------------------------------------

let textVectors;
try {
  textVectors = await embedder.embed([
    "a bright white square centred on a black background",
    "a spreadsheet of quarterly revenue figures with declining margins"
  ]);
} catch (err) {
  out(`  Text embedding FAILED: ${err.message}\n\n`);
  process.exit(1);
}

out(`  text    ${textVectors[0].length} dimensions\n`);

if (textVectors[0].length !== config.embedding.dimensions) {
  out(
    `  MISMATCH. The column is vector(${config.embedding.dimensions}) and the model ` +
      `returned ${textVectors[0].length}.\n` +
      `  The client should have refused this. If you are reading this, that check ` +
      `is not running — do not write vectors to the index until it is.\n\n`
  );
  process.exit(1);
}

// -- 2. Image ----------------------------------------------------------------

const png = makePng();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
out(`  image   ${png.length} bytes, generated locally, sent as a data URL\n`);

let imageVector;
try {
  imageVector = await embedder.embedContent(
    embedder.contentInput([{ type: "image_url", image_url: { url: dataUrl } }]),
    { inputType: "query" }
  );
  out(`          ${imageVector.length} dimensions\n`);
} catch (err) {
  out(`\n  Image embedding FAILED: ${err.message}\n\n`);
  out(
    "  The text path works, so the key is valid. If this is a 400, the provider\n" +
      "  did not accept a data: URL for image_url. The fix is to serve the image\n" +
      "  over HTTP and pass a real URL, which is how images arrive in production\n" +
      "  anyway (Phase 7 puts them in S3).\n\n"
  );
  process.exit(1);
}

if (imageVector.length !== config.embedding.dimensions) {
  out(`  MISMATCH. Image returned ${imageVector.length}, expected ${config.embedding.dimensions}.\n\n`);
  process.exit(1);
}

// -- 3. The cross-modal gate -------------------------------------------------

const matching = cosine(imageVector, textVectors[0]);
const unrelated = cosine(imageVector, textVectors[1]);

out("\n  Cosine similarity, image vector against two text vectors:\n");
out(`    vs "a bright white square..."          ${matching.toFixed(4)}   <- describes it\n`);
out(`    vs "a spreadsheet of quarterly..."    ${unrelated.toFixed(4)}   <- unrelated\n\n`);

const margin = matching - unrelated;
if (matching > unrelated && margin > 0.05) {
  out(
    `  GATE CLOSED. Cross-modal retrieval works: the image is ${margin.toFixed(4)}\n` +
      "  nearer the text that describes it. One index, one embedding space, no\n" +
      "  second vector store and no query classifier.\n\n"
  );
} else {
  out(
    `  GATE NOT MET. The margin is ${margin.toFixed(4)}.\n` +
      "  Both requests succeeded and the key works, but the image did not land\n" +
      "  nearer its own description. Do not record this as verified. A single\n" +
      "  comparison at this margin is also too weak to conclude anything — this\n" +
      "  needs a small labelled set, which is a calibration exercise rather than\n" +
      "  a smoke test.\n\n"
  );
  process.exit(1);
}
