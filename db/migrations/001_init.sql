-- ReserveOS initial schema.
--
-- Design rule 1: facts and certification records are APPEND-ONLY. The application
-- role is granted INSERT and SELECT but never UPDATE or DELETE on those tables
-- (see 002_grants.sql). Correcting a value means inserting a new row and marking
-- the old one superseded, so the state at any past instant stays reconstructible.
--
-- Design rule 2: every timestamp is TIMESTAMPTZ(3), i.e. millisecond precision.
-- Postgres stores microseconds but the node driver parses into a JS Date, which
-- holds milliseconds — so a microsecond value does not survive a write/read
-- round trip. Timestamps are serialized into hashed report payloads, and a value
-- that changes on reload would make a certified report fail its own integrity
-- check. Pinning the column precision makes the round trip exact by construction
-- rather than by convention. Enforced by test/db/roundtrip.test.ts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE issuers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name              TEXT NOT NULL,
  regulator               TEXT NOT NULL,
  kaleido_env_id          TEXT NOT NULL,
  anchor_contract_address TEXT,
  -- Business-day calendar for the redemption SLA clock.
  business_calendar       TEXT NOT NULL DEFAULT 'US_FEDERAL',
  rule_config             JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at              TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE token_deployments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id            UUID NOT NULL REFERENCES issuers(id),
  chain_id             INTEGER NOT NULL,
  contract_address     TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  decimals             SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 77),
  kaleido_connector_id TEXT NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address)
);

CREATE TABLE custodians (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id        UUID NOT NULL REFERENCES issuers(id),
  name             TEXT NOT NULL,
  -- ISO 3166-1 alpha-2. Drives the per-category custody-geography disclosure.
  jurisdiction     CHAR(2) NOT NULL,
  connector_type   TEXT NOT NULL CHECK (connector_type IN ('sftp_csv', 'api_rest', 'manual')),
  -- Credentials are stored BY REFERENCE only; never inline a secret here.
  connector_config JSONB NOT NULL DEFAULT '{}'::JSONB,
  active           BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- Facts (append-only)
-- ---------------------------------------------------------------------------

CREATE TYPE instrument_category AS ENUM
  ('CASH', 'FED_DEPOSIT', 'TBILL', 'MMF', 'REPO', 'OTHER');

CREATE TABLE reserve_facts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id           UUID NOT NULL REFERENCES issuers(id),
  custodian_id        UUID NOT NULL REFERENCES custodians(id),
  -- The custodian's stated effective time. A statement is a complete position
  -- snapshot, so reconciliation selects the latest as_of per custodian rather
  -- than summing across statements.
  as_of               TIMESTAMPTZ(3) NOT NULL,
  observed_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  instrument_category instrument_category NOT NULL,
  cusip               TEXT,
  currency            CHAR(3) NOT NULL,
  face_value_minor    BIGINT NOT NULL,
  market_value_minor  BIGINT NOT NULL CHECK (market_value_minor >= 0),
  maturity_date       DATE,
  source_document_id  UUID,
  source_hash         CHAR(64) NOT NULL,
  superseded_by       UUID REFERENCES reserve_facts(id),
  CONSTRAINT reserve_facts_no_self_supersede CHECK (superseded_by IS DISTINCT FROM id)
);

-- Hot path: current positions for an issuer at a period end.
CREATE INDEX reserve_facts_current_idx
  ON reserve_facts (issuer_id, as_of DESC)
  WHERE superseded_by IS NULL;

CREATE INDEX reserve_facts_custodian_idx ON reserve_facts (custodian_id, as_of DESC);

-- Idempotent re-ingestion of the same statement line.
CREATE UNIQUE INDEX reserve_facts_dedupe_idx
  ON reserve_facts (custodian_id, as_of, instrument_category,
                    COALESCE(cusip, ''), face_value_minor, market_value_minor);

CREATE TABLE supply_facts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_deployment_id  UUID NOT NULL REFERENCES token_deployments(id),
  block_number         BIGINT NOT NULL,
  block_timestamp      TIMESTAMPTZ(3) NOT NULL,
  -- uint256 does not fit in BIGINT. NUMERIC(78,0) holds the full range exactly.
  total_supply         NUMERIC(78, 0) NOT NULL CHECK (total_supply >= 0),
  observed_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (token_deployment_id, block_number)
);

CREATE INDEX supply_facts_lookup_idx
  ON supply_facts (token_deployment_id, block_timestamp DESC, block_number DESC);

CREATE TABLE fx_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of       TIMESTAMPTZ(3) NOT NULL,
  currency    CHAR(3) NOT NULL,
  -- Scaled by 1e8. Integer so conversion never touches floating point.
  rate_to_usd BIGINT NOT NULL CHECK (rate_to_usd > 0),
  source      TEXT NOT NULL,
  observed_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (as_of, currency, source)
);

-- ---------------------------------------------------------------------------
-- Reporting and certification
-- ---------------------------------------------------------------------------

CREATE TYPE period_status AS ENUM ('OPEN', 'IN_REVIEW', 'CERTIFIED', 'PUBLISHED');

CREATE TABLE reporting_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id    UUID NOT NULL REFERENCES issuers(id),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  status       period_status NOT NULL DEFAULT 'OPEN',
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (issuer_id, period_end),
  CONSTRAINT reporting_periods_ordered CHECK (period_end >= period_start)
);

CREATE TABLE report_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id    UUID NOT NULL REFERENCES reporting_periods(id),
  version      INTEGER NOT NULL CHECK (version >= 1),
  payload      JSONB NOT NULL,
  -- SHA-256 over RFC 8785 canonical JSON. This is what gets signed and anchored.
  payload_hash CHAR(64) NOT NULL,
  generated_at TIMESTAMPTZ(3) NOT NULL,
  generated_by UUID NOT NULL,
  UNIQUE (period_id, version),
  UNIQUE (payload_hash)
);

CREATE TYPE approval_role AS ENUM ('PREPARER', 'COMPLIANCE', 'CFO', 'CEO');
CREATE TYPE approval_decision AS ENUM ('APPROVED', 'REJECTED');

CREATE TABLE approvals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_version_id UUID NOT NULL REFERENCES report_versions(id),
  role              approval_role NOT NULL,
  actor_id          UUID NOT NULL,
  actor_email       TEXT NOT NULL,
  decision          approval_decision NOT NULL,
  -- The exact wording displayed to the signer. Someone is accepting personal
  -- criminal liability; the record must show what they actually saw.
  attestation_text  TEXT NOT NULL,
  signature         TEXT NOT NULL,
  signed_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  pms_decision_id   TEXT,
  -- One decision per role per version. A change of mind is a new version.
  UNIQUE (report_version_id, role)
);

-- ---------------------------------------------------------------------------
-- Evidence anchoring
-- ---------------------------------------------------------------------------

CREATE TYPE anchor_subject AS ENUM ('DAILY_ROLLUP', 'REPORT_VERSION', 'APPROVAL');
CREATE TYPE anchor_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

CREATE TABLE anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id         UUID NOT NULL REFERENCES issuers(id),
  subject_type      anchor_subject NOT NULL,
  subject_id        UUID NOT NULL,
  merkle_root       CHAR(64) NOT NULL,
  kaleido_operation_id TEXT,
  besu_tx_hash      TEXT,
  besu_block_number BIGINT,
  public_tether_ref TEXT,
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  anchored_at       TIMESTAMPTZ(3),
  status            anchor_status NOT NULL DEFAULT 'PENDING',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  -- Anchoring is retried on failure; this makes a duplicate impossible.
  UNIQUE (subject_type, subject_id)
);

CREATE INDEX anchors_pending_idx ON anchors (status, created_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Redemption SLA
-- ---------------------------------------------------------------------------

CREATE TYPE redemption_status AS ENUM
  ('RECEIVED', 'PROCESSING', 'SETTLED', 'REJECTED', 'BREACHED');

CREATE TABLE redemption_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id     UUID NOT NULL REFERENCES issuers(id),
  external_ref  TEXT NOT NULL,
  requested_at  TIMESTAMPTZ(3) NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  -- Two business days on the issuer's calendar, per the OCC proposed standard.
  sla_deadline  TIMESTAMPTZ(3) NOT NULL,
  settled_at    TIMESTAMPTZ(3),
  status        redemption_status NOT NULL DEFAULT 'RECEIVED',
  breach_reason TEXT,
  UNIQUE (issuer_id, external_ref)
);

CREATE INDEX redemption_open_idx
  ON redemption_requests (issuer_id, sla_deadline)
  WHERE status IN ('RECEIVED', 'PROCESSING');

-- ---------------------------------------------------------------------------
-- Access log (itself included in the daily rollup)
-- ---------------------------------------------------------------------------

CREATE TABLE access_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issuer_id   UUID NOT NULL REFERENCES issuers(id),
  actor_id    UUID,
  actor_email TEXT,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  occurred_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX access_log_issuer_idx ON access_log (issuer_id, occurred_at DESC);

COMMIT;
