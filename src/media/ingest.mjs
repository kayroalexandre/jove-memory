import { createHash } from "node:crypto";

import { extractPdfText, isPdf } from "./pdf.mjs";

/**
 * Media ingest.
 *
 * The order of operations is the design, and it is deliberately the opposite of
 * what is convenient: **verify the bytes, then upload, then record**. A record
 * pointing at bytes that are not there, or at bytes that are not what was
 * hashed, is a record that retrieves nothing and reports coverage.
 *
 * ## Content-addressed ids
 *
 * The media id is the sha256 of the bytes. Two uploads of the same file are one
 * row and one object, which is what makes deduplication a property of the schema
 * rather than a cleanup job. It also means a caller cannot invent an id and
 * overwrite someone else's file: overwriting requires the same bytes.
 *
 * ## Sniffed, not declared
 *
 * A caller-supplied MIME type is a hint. `extractPdfText` checks the `%PDF-`
 * magic itself, and the recorded `content_type_source` says whether the type
 * was declared or sniffed. A file that declares `image/png` and starts with
 * `%PDF-` is recorded as a PDF, and the discrepancy is visible rather than
 * discovered later by a failed render.
 */

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * What the bytes actually are, by magic number only.
 *
 * Returns null when the bytes are not recognised. The extension is **not**
 * consulted here, because a `.pdf` extension is a claim by whoever named the
 * file, and the first version trusted it — so a plain text file named
 * `lies.pdf` was recorded as `application/pdf` with the source "sniffed",
 * which is a lie in a field whose whole purpose is to say where a type came
 * from.
 */
export function sniffFromBytes(bytes) {
  if (isPdf(bytes)) return "application/pdf";
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return null;
}

/**
 * What this file is, and where that came from.
 *
 * Three sources, in descending order of trust:
 *
 *   sniffed   the bytes have a magic number that says what they are
 *   extension the bytes are unrecognised and the filename claims a known type
 *   declared   neither, and the caller says so
 *   octet     nothing was known
 *
 * A file whose magic says PDF and whose extension says PNG is recorded as a
 * PDF with a `typeMismatch` flag, rather than silently resolved in favour of
 * whichever was checked first.
 */
export function sniffContentType(bytes, filename = "", declaredType = null) {
  const sniffed = sniffFromBytes(bytes);
  if (sniffed) return { contentType: sniffed, source: "sniffed" };

  const extension = extensionOf(filename);
  if (extension === ".pdf") return { contentType: "application/pdf", source: "extension" };
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { contentType: `image/${extension.slice(1) === "jpeg" ? "jpeg" : extension.slice(1)}`, source: "extension" };
  }

  if (declaredType) return { contentType: declaredType, source: "declared" };
  return { contentType: "application/octet-stream", source: "unknown" };
}

export function createMediaIngestor({
  store,
  s3,
  embedder = null,
  describer = null,
  inference = null,
  logger = null
}) {
  /**
   * Ingest one media object.
   *
   * Never throws. A caller uploading a photo is not asking for an exception, and
   * a failed media write should not take down the memory write it was part of —
   * the same reasoning as the write gate's three outcomes.
   *
   * @param {object} input
   * @param {Buffer} input.bytes
   * @param {string} [input.filename]
   * @param {string} [input.declaredType] what the caller says it is
   * @param {string} [input.caption]
   * @param {string} [input.itemId]
   * @returns {Promise<object>}
   */
  async function ingest({ bytes, filename = null, declaredType = null, caption = null, itemId = null, describe = true }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return { ok: false, reason: "empty", detail: "no bytes were supplied" };
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = sha256;

    const detected = sniffContentType(bytes, filename ?? "", declaredType);
    // `source`, not `contentTypeSource`. The function returns `source` because
    // that is what it is; renaming on the way out keeps the column name in the
    // result and the property name in the detector from drifting apart. The
    // first version destructured a `contentTypeSource` that the function never
    // set, so every upload recorded `contentType_source: undefined` and the
    // database default silently supplied 'declared' — a type that was really
    // sniffed being reported as something the caller said.
    const { contentType, source: contentTypeSource } = detected;

    // A disagreement is reported rather than resolved silently. Which one is
    // right depends on why the file was named that, and the answer is not
    // knowable from the bytes.
    const typeMismatch =
      Boolean(declaredType) && contentTypeSource === "sniffed" && declaredType !== contentType
        ? `declared ${declaredType}, bytes are ${contentType}`
        : null;

    // Deduplicated. Re-uploading identical bytes costs nothing beyond the
    // hash, which is the point of content addressing.
    const existing = await store.findMediaByHash(sha256);
    if (existing) {
      if (itemId && existing.item_id !== itemId) {
        await store.attachMediaToItem(id, itemId);
      }
      // The same shape as a fresh ingest, with the fields that only a new
      // upload computes carried over from the row that already exists. The
      // first version returned a shorter object, so a caller checking
      // `result.contentType` got `undefined` on every repeat upload — which is
      // exactly the upload a test suite runs twice.
      return {
        ok: true,
        id,
        deduplicated: true,
        media: existing,
        sha256,
        sizeBytes: Number(existing.size_bytes ?? bytes.length),
        contentType: existing.content_type,
        contentTypeSource: existing.content_type_source,
        typeMismatch,
        etag: existing.etag,
        etagUsedForIntegrity: false,
        extracted: Boolean(existing.extracted_text),
        extractionMethod: existing.extraction_method,
        extractionError: existing.extraction_error
      };
    }

    const objectKey = buildKey({
      // The store knows which workspace it is for; asking the caller to pass it
      // a second time is an opportunity to pass the wrong one.
      workspace: store.workspaceName,
      filename,
      contentType,
      sha256
    });

    // 1. Upload. If this fails nothing has been recorded, so there is no
    //    dangling pointer to clean up.
    let stored;
    try {
      stored = await s3.put(objectKey, bytes, {
        contentType,
        // The hash travels with the bytes, so a read can verify without
        // consulting the database first.
        metadata: { sha256, filename: filename ?? "" }
      });
    } catch (err) {
      logger?.warn("media upload failed", { message: err.message, objectKey });
      return { ok: false, reason: "upload_failed", detail: err.message, sha256 };
    }

    // 2. Extract, where the type has text to extract.
    let extractedText = null;
    let extractionMethod = null;
    let extractionError = null;

    if (contentType === "application/pdf") {
      const extraction = extractPdfText(bytes);
      extractedText = extraction.text || null;
      extractionMethod = extraction.method;
      extractionError = extraction.reason;
      // Reported, not fatal. A scanned PDF is a real document the user chose to
      // keep, and refusing it because it has no text layer would be a worse
      // answer than storing it with the reason attached.
    } else if (contentType.startsWith("image/")) {
      const described = await describeImage({ bytes, contentType, caption, describer, inference, logger });
      extractedText = described.text;
      extractionMethod = described.method;
      extractionError = described.reason;
    } else {
      extractionMethod = "none";
      extractionError = `no text extraction for ${contentType}`;
    }

    // 3. Record, last, so a record never points at absent bytes.
    const media = await store.upsertMedia({
      id,
      bucket: s3.bucket,
      objectKey: stored.key,
      sha256,
      etag: stored.etag,
      contentType,
      contentTypeSource,
      sizeBytes: stored.size,
      extractedText,
      extractionMethod,
      extractionError,
      caption,
      itemId
    });

    await store.recordMediaMutation({
      mediaId: id,
      operation: "upload",
      sizeBytes: stored.size,
      sha256,
      note: filename
    });

    const outcome = {
      ok: true,
      id,
      // On both paths, so a caller can read the flag without first knowing
      // whether this call deduplicated.
      deduplicated: false,
      media,
      sha256,
      sizeBytes: stored.size,
      contentType,
      contentTypeSource,
      typeMismatch,
      etag: stored.etag,
      // Said, because the ETag was stored and a reader may wonder whether it
      // was verified against.
      etagUsedForIntegrity: false,
      extracted: Boolean(extractedText),
      extractionMethod,
      extractionError
    };

    return outcome;
  }

  /**
   * Describe an image, so it can be embedded in the same space as text.
   *
   * Multimodal embedding makes this unnecessary in principle — an image can be
   * embedded directly. It is still the default, for one reason: a description
   * is *text*, and text is retrievable by the lexical and graph arms. An image
   * embedded but not described is a memory only one of four arms can find.
   *
   * Set `describe: false` to embed the pixels alone, which is the pure
   * multimodal path and the one ADR-005 is about. Both are supported; the
   * description is the default because it makes the media findable by more arms
   * than the vector one.
   */
  async function describeImage({ bytes, contentType, caption, describer, inference, logger }) {
    if (describer) {
      try {
        const text = await describer({ bytes, contentType, caption });
        return { text, method: "describer", reason: null };
      } catch (err) {
        logger?.warn("image description failed", { message: err.message });
        return { text: caption, method: "caption-only", reason: `describer failed: ${err.message}` };
      }
    }

    if (inference) {
      try {
        const text = await inference.describeImage({ bytes, contentType, caption });
        return { text, method: "inference", reason: null };
      } catch (err) {
        logger?.warn("image description via inference failed", { message: err.message });
        return { text: caption, method: "caption-only", reason: `inference failed: ${err.message}` };
      }
    }

    // No describer configured. The caption is what there is, and saying so is
    // more useful than a fabricated description.
    return {
      text: caption,
      method: caption ? "caption-only" : "none",
      reason: caption
        ? "no describer configured; only the caption is searchable"
        : "no describer configured and no caption: this media has no text"
    };
  }

  /**
   * Embed attached media.
   *
   * Only media with `item_id` set, because bytes that belong to no memory are
   * not recallable content — embedding them would inflate the coverage number
   * with items nothing can retrieve.
   *
   * What is embedded is the media's text: extracted text for a PDF, description
   * plus caption for an image. That is deliberate — the same text the other
   * three arms index, in the one space they cannot use.
   */
  async function embedMedia({ model = null, limit = 100 } = {}) {
    const pending = await store.listUnembeddedMedia({ model, limit });
    if (pending.length === 0) return { embedded: 0, skipped: 0, failures: [] };

    if (!embedder?.available?.()) {
      return { embedded: 0, skipped: pending.length, failures: [], reason: "no embedding provider configured" };
    }

    const embeddable = pending.filter((row) => row.extracted_text && row.extracted_text.trim() !== "");
    const failures = [];

    for (const row of pending) {
      if (!row.extracted_text || row.extracted_text.trim() === "") {
        // Not a failure. Media with no text has nothing to embed, and
        // embedding a caption's absence produces a vector of an empty string.
        continue;
      }
      try {
        const [vector] = await embedder.embed([embedTextFor(row)], { model });
        await store.upsertMediaEmbedding(row.id, model ?? embedder.model, vector);
      } catch (err) {
        failures.push({ id: row.id, reason: err.message });
        logger?.warn("media embedding failed", { mediaId: row.id, message: err.message });
      }
    }

    return { embedded: embeddable.length - failures.length, skipped: pending.length - embeddable.length, failures };
  }

  /**
   * Fetch bytes back, verifying.
   *
   * The verification is not optional. `s3.get` recomputes the sha256 and
   * compares it to the one recorded at upload, and throws on a mismatch. An
   * ETag is never used for this (ADR-011).
   */
  async function fetchMedia(id, { verify = true } = {}) {
    const media = await store.readMedia(id);
    if (!media) return { ok: false, reason: "not_found" };

    try {
      const object = await s3.get(media.object_key, { verify });
      return {
        ok: true,
        media,
        bytes: object.body,
        contentType: object.content_type ?? media.content_type,
        // Reported so a caller can see the hash was checked rather than assumed.
        verified: verify,
        sha256: object.sha256,
        // Whether the ETag agrees, reported and never acted on. A disagreement
        // with an agreeing sha256 means the object was rewritten with the same
        // content, which is a fact worth knowing and not a corruption.
        etagAgrees: object.etag === media.etag
      };
    } catch (err) {
      return { ok: false, reason: err.code ?? "fetch_failed", detail: err.message, media };
    }
  }

  /**
   * Verify every media row against the bytes in the store.
   *
   * "Which of my files are corrupted", answered rather than theorised. Fetches
   * every object and compares hashes, so it is a network call per row and is
   * expected to be run deliberately.
   */
  async function verifyAll({ limit = 500 } = {}) {
    const rows = await store.listMedia({ limit });
    const verified = [];
    const corrupt = [];
    const missing = [];

    for (const row of rows) {
      const result = await fetchMedia(row.id, { verify: true });
      if (!result.ok) {
        if (result.reason === "not_found") missing.push(row.id);
        else corrupt.push({ id: row.id, reason: result.reason, detail: result.detail });
        continue;
      }
      verified.push(row.id);
    }

    return {
      checked: rows.length,
      verified: verified.length,
      corrupt,
      missing,
      // The headline, and the reason this function exists.
      intact: verified.length === rows.length
    };
  }

  return { ingest, embedMedia, fetchMedia, verifyAll, sniffContentType };
}

/** What gets embedded: the same text the other three arms index. */
function embedTextFor(row) {
  const parts = [];
  if (row.caption) parts.push(row.caption);
  parts.push(row.extracted_text);
  return parts.join("\n\n");
}

/**
 * The object key.
 *
 * Sharded by the first two hex characters of the hash, because a bucket with
 * one flat prefix of a few thousand objects is a bucket where every listing is a
 * full scan. The hash also means the key is stable: the same file always lands
 * at the same place, so a re-upload is a no-op rather than a second copy.
 */
function buildKey({ workspace, filename, contentType, sha256 }) {
  const extension = extensionOf(filename) || extensionFor(contentType);
  // Slashes and other punctuation become dashes, and then dot-runs collapse.
  //
  // The second step is the one that was missing: `../../etc/passwd.png` became
  // `..-..-etc-passwd.png`, which contains no slash and is therefore not a
  // path traversal — and is still a key that reads as a traversal, sorts as
  // one, and would defeat a prefix-scoped policy written by eye. A key should
  // not be able to look like something it is not.
  const safeName = (filename ?? "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 60);

  // The hash, then the caller's name. The first version did
  // `base.endsWith(extension) ? "" : extension`, which meant a file that
  // already had an extension got *no* extension in its key — `photo.png`
  // became `<hash>` with nothing at all, so the key said nothing about what
  // the object is and a listing was unreadable.
  const suffix = safeName ? `-${safeName}` : extension;
  return `${workspace}/${sha256.slice(0, 2)}/${sha256}${suffix}`;
}

function extensionOf(filename) {
  if (!filename) return "";
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]{1,5}$/);
  return match ? match[0] : "";
}

function extensionFor(contentType) {
  return (
    {
      "application/pdf": ".pdf",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg"
    }[contentType] ?? ".bin"
  );
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function looksLikeSvg(bytes) {
  const head = bytes.subarray(0, 256).toString("utf8").trimStart();
  return head.startsWith("<?xml") || head.startsWith("<svg");
}
