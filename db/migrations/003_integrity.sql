-- Integrity hardening, plus the source-document lineage table.
--
-- Everything here closes a defect found by review of 001, not a new feature.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Hash columns: CHAR(64) -> TEXT with a format CHECK
-- ---------------------------------------------------------------------------
-- CHAR(n) is blank-padded. Storing a short value silently pads it to width, so a
-- truncated or malformed hash reads back as a well-formed 64-character string
-- and any length check on read passes. This bit two independent call sites:
-- `anchors.merkle_root` (a padded root would be anchored on chain) and
-- `report_versions.payload_hash` (bpchar comparison ignores trailing blanks, so
-- lookup-by-hash still matched the corrupt row and hid the damage).
--
-- Application-level guards were added at both sites, but the hazard belongs to
-- the column type. TEXT plus a regex CHECK removes the whole class: a bad hash
-- now fails at write time, at every call site, including ones written later.

ALTER TABLE reserve_facts   ALTER COLUMN source_hash  TYPE TEXT;
ALTER TABLE report_versions ALTER COLUMN payload_hash TYPE TEXT;
ALTER TABLE anchors         ALTER COLUMN merkle_root  TYPE TEXT;

-- Existing rows were written by the guarded paths, but they may carry padding
-- from before this migration; strip it before the constraints go on.
UPDATE reserve_facts   SET source_hash  = rtrim(source_hash);
UPDATE report_versions SET payload_hash = rtrim(payload_hash);
UPDATE anchors         SET merkle_root  = rtrim(merkle_root);

ALTER TABLE reserve_facts
  ADD CONSTRAINT reserve_facts_source_hash_format
  CHECK (source_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE report_versions
  ADD CONSTRAINT report_versions_payload_hash_format
  CHECK (payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE anchors
  ADD CONSTRAINT anchors_merkle_root_format
  CHECK (merkle_root ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- 2. Face value must be non-negative
-- ---------------------------------------------------------------------------
-- `market_value_minor` carried this check from the start; `face_value_minor` did
-- not, so an accounting-parenthesised par value like "(1,250,000.00)" parsed to a
-- negative and would have been accepted. The ingestion layer now rejects it too;
-- this is the backstop for every other writer.

ALTER TABLE reserve_facts
  ADD CONSTRAINT reserve_facts_face_value_non_negative
  CHECK (face_value_minor >= 0);

-- ---------------------------------------------------------------------------
-- 3. Source-document lineage
-- ---------------------------------------------------------------------------
-- `reserve_facts.source_document_id` existed in 001 as a dangling UUID with no
-- referent. When a figure on a certified report is questioned months later, the
-- exact bytes it came from must be recoverable — that is the difference between
-- an evidence trail and an assertion.

CREATE TYPE source_document_status AS ENUM ('INGESTED', 'REJECTED', 'SUPERSEDED');

CREATE TABLE source_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id      UUID NOT NULL REFERENCES issuers(id),
  custodian_id   UUID REFERENCES custodians(id),
  filename       TEXT NOT NULL,
  -- SHA-256 of the raw bytes as delivered, before any parsing.
  content_hash   TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_size      BIGINT NOT NULL CHECK (byte_size >= 0),
  -- The statement's effective date, once parsed. NULL for a rejected document.
  statement_as_of TIMESTAMPTZ(3),
  row_count      INTEGER CHECK (row_count >= 0),
  status         source_document_status NOT NULL DEFAULT 'INGESTED',
  rejection_reason TEXT,
  ingested_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Re-delivering identical bytes is a no-op rather than a second ingestion.
  UNIQUE (issuer_id, content_hash)
);

CREATE INDEX source_documents_custodian_idx
  ON source_documents (custodian_id, ingested_at DESC);

ALTER TABLE reserve_facts
  ADD CONSTRAINT reserve_facts_source_document_fk
  FOREIGN KEY (source_document_id) REFERENCES source_documents(id);

-- ---------------------------------------------------------------------------
-- 4. Redemption breach reasons
-- ---------------------------------------------------------------------------
-- `breach_reason` existed but nothing could populate it, because the domain type
-- had no such field. The report pack is required to state breach counts *with
-- reasons*, so the column needs a companion timestamp to be useful in a summary.

ALTER TABLE redemption_requests
  ADD COLUMN breached_at TIMESTAMPTZ(3);

COMMIT;
