-- Users, API tokens, and the public verification role.
--
-- Two access paths exist and they are deliberately different shapes:
--
--   1. The issuer's own staff, authenticated, tenant-scoped by RLS (005).
--   2. An examiner or member of the public verifying a PUBLISHED report. No
--      account, no tenant — but also no access to anything unpublished. That is
--      enforced by a dedicated role with its own policies rather than by
--      application code, so a routing mistake cannot expose a draft.

BEGIN;

CREATE TYPE user_role AS ENUM (
  'VIEWER',
  'PREPARER',
  'COMPLIANCE',
  'CFO',
  'CEO',
  'ADMIN'
);

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id    UUID NOT NULL REFERENCES issuers(id),
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  roles        user_role[] NOT NULL DEFAULT '{}',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (issuer_id, email)
);

CREATE TABLE api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  -- SHA-256 of the bearer token. The token itself is shown once at creation and
  -- never stored. A plain hash is right here, unlike for a password: the token is
  -- 32 bytes of CSPRNG output, so there is no dictionary to attack and the
  -- deliberate slowness of bcrypt/argon2 would only cost latency on every
  -- request.
  token_hash    TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Executive certification requires proof of presence at signing time, not
  -- merely a live session. Set by a WebAuthn step-up and short-lived.
  step_up_at    TIMESTAMPTZ(3),
  expires_at    TIMESTAMPTZ(3) NOT NULL,
  revoked_at    TIMESTAMPTZ(3),
  last_used_at  TIMESTAMPTZ(3),
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

-- `users` and `api_tokens` carry no RLS policy on purpose: authentication has to
-- read them BEFORE the tenant is known, since the tenant is derived from the
-- token. Lookup is by exact token hash, which is unguessable. Every query after
-- authentication runs inside `withTenant` and is policy-filtered as normal.

GRANT SELECT ON users, api_tokens TO reserveos_app;
GRANT UPDATE (last_used_at) ON api_tokens TO reserveos_app;
GRANT INSERT, UPDATE, DELETE ON users TO reserveos_app;
GRANT INSERT, UPDATE ON api_tokens TO reserveos_app;

-- ---------------------------------------------------------------------------
-- Public verification role
-- ---------------------------------------------------------------------------
-- Used by the unauthenticated examiner portal. It can read exactly enough to
-- verify a published report and nothing else — no draft periods, no breach
-- detail, no custodian identities, no lineage.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reserveos_public') THEN
    CREATE ROLE reserveos_public NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO reserveos_public;

-- Column-level: the issuer's legal identity is part of the disclosure, but its
-- Kaleido environment and rule configuration are not.
GRANT SELECT (id, legal_name, regulator) ON issuers TO reserveos_public;
GRANT SELECT (id, issuer_id, period_start, period_end, status) ON reporting_periods
  TO reserveos_public;
GRANT SELECT (id, period_id, version, payload, payload_hash, generated_at) ON report_versions
  TO reserveos_public;
GRANT SELECT (id, subject_type, subject_id, merkle_root, besu_tx_hash, besu_block_number,
              anchored_at, status, public_tether_ref)
  ON anchors TO reserveos_public;

CREATE POLICY reporting_periods_published ON reporting_periods
  FOR SELECT TO reserveos_public
  USING (status = 'PUBLISHED');

CREATE POLICY report_versions_published ON report_versions
  FOR SELECT TO reserveos_public
  USING (
    EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.id = report_versions.period_id
         AND p.status = 'PUBLISHED'
    )
  );

-- Only anchors that commit to a published report version. An anchor over a daily
-- rollup or an approval reveals ingestion cadence and signing activity, which is
-- operational information the public has no claim to.
CREATE POLICY anchors_published ON anchors
  FOR SELECT TO reserveos_public
  USING (
    subject_type = 'REPORT_VERSION'
    AND EXISTS (
      SELECT 1 FROM report_versions v
       JOIN reporting_periods p ON p.id = v.period_id
       WHERE v.id = anchors.subject_id
         AND p.status = 'PUBLISHED'
    )
  );

CREATE POLICY issuers_published ON issuers
  FOR SELECT TO reserveos_public
  USING (
    EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.issuer_id = issuers.id
         AND p.status = 'PUBLISHED'
    )
  );

-- The API serves verification from the same pool it uses for everything else,
-- downgrading itself with SET LOCAL ROLE for the duration of that transaction.
-- Membership is what makes that switch legal; the switch is what makes the
-- public policies apply.
GRANT reserveos_public TO reserveos_app;

COMMIT;
