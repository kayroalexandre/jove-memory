-- ---------------------------------------------------------------------------
-- 0004 — Media.
--
-- Bytes in S3-compatible storage (ADR-011). This table holds a pointer, a
-- sha256, a MIME type, extracted text, and provenance.
--
-- The sha256 is the integrity proof and the ETag is not, which is a distinction
-- worth a column comment: a multipart upload's ETag looks like `abc123-4` and is
-- not a content hash, so a system that verified against it would pass
-- verification for a file truncated across parts. The ETag is stored anyway,
-- because a changed ETag with an unchanged sha256 is a useful signal that
-- something was rewritten — as long as nothing treats it as the authority.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media (
  -- Content-addressed by the caller: the sha256 of the bytes, so two uploads of
  -- the same file are the same row. A random id would let a duplicate be stored
  -- twice, which for a memory system means the same image retrieved twice.
  id            TEXT        NOT NULL,

  workspace     TEXT        NOT NULL,

  -- Where the bytes are. `key` is relative to the bucket.
  bucket        TEXT        NOT NULL,
  object_key    TEXT        NOT NULL,

  -- The integrity proof. Computed by this system before upload and verified on
  -- read.
  sha256        TEXT        NOT NULL,

  -- Recorded, never trusted. See the header.
  etag          TEXT,

  -- The MIME type, and whether it was declared or sniffed. A caller-supplied
  -- type is a hint; a file that says `image/png` and starts with `%PDF-` is a
  -- file whose type was guessed badly.
  content_type        TEXT NOT NULL,
  content_type_source TEXT NOT NULL DEFAULT 'declared',

  size_bytes    BIGINT      NOT NULL,

  -- Text extracted from the media, for a PDF, and the description for an image.
  -- An image has no text; it has a description, and the column holds either.
  extracted_text    TEXT,
  extraction_method TEXT,

  -- Why extraction produced nothing, when it did. A media record with empty
  -- text and no reason is indistinguishable from a media record that was
  -- indexed, and it retrieves nothing while reporting full coverage.
  extraction_error  TEXT,

  -- The media's own embedding, in the same space as everything else
  -- (ADR-005). One vector per media item, so an image query finds text
  -- memories and a text query finds images.
  embedding_model TEXT,
  embedding       vector(3072),

  -- What it is attached to. Null for media that is not yet part of a memory.
  item_id      TEXT,

  -- A caption or filename supplied by the caller. Indexed alongside the
  -- description, because "the photo from Porto" is a better query than anything
  -- derived from pixels.
  caption      TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace, id),

  -- Integrity is a first-class lookup: "which of my files are corrupted" is a
  -- question worth being able to ask in SQL.
  CONSTRAINT media_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_size_positive CHECK (size_bytes >= 0)
);

-- The common lookups: media attached to an item, and media by content.
CREATE INDEX IF NOT EXISTS media_item_idx    ON media(workspace, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_created_idx ON media(workspace, created_at DESC);

-- No index on the embedding column, and that is a measured decision rather
-- than an oversight.
--
-- The first version of this migration created a plain B-tree on
-- `embedding`, the same fallback used for memory_item_vectors. It cannot be
-- created: a 3072-dimension vector serialises to 12320 bytes of index entry
-- and PostgreSQL's limit is 8191.
--
--   ERROR:  index row requires 12320 bytes, maximum size is 8191
--
-- Which would have been the wrong index anyway. An exact search computes a
-- distance per row and orders by it; nothing looks a vector up by equality, so
-- a B-tree on the column is never consulted. And an HNSW index is impossible
-- at 3072 dimensions regardless (docs/OPERATIONS.md, "pgvector cannot index
-- 3072 dimensions").
--
-- What is indexed instead is what is actually queried: which media is
-- attached, which is large, and which has a hash that matches. A distance scan
-- is a sequential scan, and pretending otherwise would be an index that exists
-- to be ignored.
--
-- If a corpus ever grows large enough for that to hurt, the fix is a narrower
-- embedding (1536 or 2048 permits HNSW) and a data migration — not a bigger
-- index entry.
CREATE INDEX IF NOT EXISTS media_sha_idx ON media(workspace, sha256);

-- ---------------------------------------------------------------------------
-- Media mutations
--
-- Append-only, like memory_mutations and credentials_audit. Uploading bytes is
-- the most expensive write in the system, and knowing which files came from
-- where is the kind of question that has to be answerable after the fact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_mutations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace  TEXT        NOT NULL,
  media_id   TEXT        NOT NULL,
  operation  TEXT        NOT NULL,
  size_bytes BIGINT,
  sha256     TEXT,
  note       TEXT
);

CREATE OR REPLACE FUNCTION media_mutations_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'media_mutations is append-only. A history of uploads that can be edited is '
    'not a history of uploads.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_mutations_no_update ON media_mutations;
CREATE TRIGGER media_mutations_no_update
  BEFORE UPDATE OR DELETE ON media_mutations
  FOR EACH ROW EXECUTE FUNCTION media_mutations_append_only();

CREATE INDEX IF NOT EXISTS media_mutations_at_idx    ON media_mutations(workspace, at DESC);
CREATE INDEX IF NOT EXISTS media_mutations_media_idx ON media_mutations(media_id, at DESC);
