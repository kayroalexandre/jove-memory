-- ---------------------------------------------------------------------------
-- 0003 — Provider credentials.
--
-- The web settings form writes the OpenRouter key here, and the key is stored
-- encrypted rather than in the clear.
--
-- The encryption key is NOT in this database. It lives in a mode-600 file
-- outside the repository (see `src/api/credentials.mjs` and
-- docs/OPERATIONS.md), and only its scrypt-derived subkey ever touches this
-- table. That separation is the entire point: a database dump — a backup, a
-- replica, a `pg_dump` pasted into an issue — yields ciphertext, not a
-- credential. An attacker needs both halves, and the halves live in different
-- places with different exposure.
--
-- This is deliberately *not* the same thing as the key in an environment
-- variable, and it is worth being clear about why both exist:
--
--   this table   — the operator manages the key from a form, the value
--                  survives a restart, and it is per-deployment rather than
--                  per-shell.
--   the file      — the master key, which cannot live in the database it
--                  protects, and which is what makes the ciphertext here
--                  mean something.
--
-- What this does not protect against: an attacker who can read both the
-- database and the filesystem as this user. At that point the key is
-- recoverable, and no amount of encryption in one place changes that. The
-- threat model is in docs/SECURITY.md.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_credentials (
  -- The provider, e.g. 'openrouter'. Part of the key because a second provider
  -- is a foreseeable requirement and retrofitting one means a migration and a
  -- data move.
  provider    TEXT        NOT NULL,

  -- What kind of secret this is. 'api_key' today; a future 'signing_key' is a
  -- row rather than a migration.
  kind        TEXT        NOT NULL DEFAULT 'api_key',

  -- AES-256-GCM. Three separate columns because they are three separate
  -- things, and merging them into one opaque blob is how a future
  -- implementation ends up unable to tell a nonce from a tag.
  ciphertext  BYTEA       NOT NULL,
  nonce       BYTEA       NOT NULL,
  auth_tag    BYTEA       NOT NULL,

  -- Which key encrypted this, so rotating the master key can find the rows
  -- still under the old one. A rotation that cannot identify its own work is
  -- a rotation that loses data.
  key_version TEXT        NOT NULL DEFAULT 'v1',

  -- Never the value. A last-four field is convenient and is a disclosure: four
  -- characters narrows a key space far more than it feels like, and this
  -- system has no use for it that is not served by a fingerprint of the
  -- ciphertext instead.
  ciphertext_fingerprint TEXT NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (provider, kind)
);

-- Rotation: re-encrypt under a new key_version. Without this, finding the rows
-- that still need it means a full scan and a comparison in application code.
CREATE INDEX IF NOT EXISTS provider_credentials_version_idx
  ON provider_credentials(key_version);

-- ---------------------------------------------------------------------------
-- Settings audit.
--
-- Who changed the credential, and when. Not the value, and not a diff of it —
-- a diff of two keys is not reconstructible and is a leak in waiting.
--
-- Append-only, like `memory_mutations`. A settings change that can be edited
-- afterwards is not an audit trail.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credentials_audit (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider    TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  operation   TEXT        NOT NULL,

  -- 'set' or 'clear'. Never the value.
  -- actor      TEXT,
  note        TEXT
);

CREATE OR REPLACE FUNCTION credentials_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'credentials_audit is append-only. An audit trail that can be edited is '
    'not an audit trail.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credentials_audit_no_update ON credentials_audit;
CREATE TRIGGER credentials_audit_no_update
  BEFORE UPDATE OR DELETE ON credentials_audit
  FOR EACH ROW EXECUTE FUNCTION credentials_audit_append_only();
