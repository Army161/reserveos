-- Row-level security: tenant isolation enforced by the database.
--
-- Every store method could take an `issuer_id` and filter on it, but that is
-- isolation by convention: one method written later that forgets the predicate
-- silently exposes another issuer's reserve positions. This codebase already
-- enforces append-only with GRANTs rather than discipline, and isolation gets
-- the same treatment — a query that omits the filter returns nothing rather than
-- everything.
--
-- The application connects as `reserveos_app` and sets `app.issuer_id` for the
-- transaction (see `withTenant` in src/db/pool.ts). Superusers and the table
-- owner bypass RLS, which is what migrations, the test harness, and genuinely
-- cross-tenant background sweeps rely on.

BEGIN;

/**
 * The issuer scoping the current transaction, or NULL when unset.
 *
 * The `true` second argument makes `current_setting` return NULL instead of
 * raising when the variable was never set, so an unscoped session fails closed:
 * `issuer_id = NULL` is NULL, never true, so every policy filters every row.
 */
CREATE FUNCTION app_current_issuer() RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.issuer_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Directly scoped tables
-- ---------------------------------------------------------------------------
-- WITH CHECK matters as much as USING: without it a tenant could INSERT a row
-- carrying another tenant's issuer_id, which reads back as that tenant's data.

ALTER TABLE issuers ENABLE ROW LEVEL SECURITY;
CREATE POLICY issuers_tenant ON issuers
  FOR ALL
  USING (id = app_current_issuer())
  WITH CHECK (id = app_current_issuer());

ALTER TABLE custodians ENABLE ROW LEVEL SECURITY;
CREATE POLICY custodians_tenant ON custodians
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE token_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY token_deployments_tenant ON token_deployments
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE reserve_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY reserve_facts_tenant ON reserve_facts
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE reporting_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY reporting_periods_tenant ON reporting_periods
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY anchors_tenant ON anchors
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE redemption_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY redemption_requests_tenant ON redemption_requests
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE source_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_documents_tenant ON source_documents
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

ALTER TABLE access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_log_tenant ON access_log
  FOR ALL
  USING (issuer_id = app_current_issuer())
  WITH CHECK (issuer_id = app_current_issuer());

-- ---------------------------------------------------------------------------
-- Indirectly scoped tables
-- ---------------------------------------------------------------------------
-- These carry no issuer_id of their own, so the policy walks the foreign key.
-- The subqueries read RLS-protected tables and are therefore filtered again by
-- those tables' policies; the explicit predicate is kept so each policy states
-- its own intent rather than depending on another table's.

ALTER TABLE supply_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY supply_facts_tenant ON supply_facts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM token_deployments d
       WHERE d.id = supply_facts.token_deployment_id
         AND d.issuer_id = app_current_issuer()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM token_deployments d
       WHERE d.id = supply_facts.token_deployment_id
         AND d.issuer_id = app_current_issuer()
    )
  );

ALTER TABLE report_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_versions_tenant ON report_versions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.id = report_versions.period_id
         AND p.issuer_id = app_current_issuer()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.id = report_versions.period_id
         AND p.issuer_id = app_current_issuer()
    )
  );

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_tenant ON approvals
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM report_versions v
       JOIN reporting_periods p ON p.id = v.period_id
       WHERE v.id = approvals.report_version_id
         AND p.issuer_id = app_current_issuer()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM report_versions v
       JOIN reporting_periods p ON p.id = v.period_id
       WHERE v.id = approvals.report_version_id
         AND p.issuer_id = app_current_issuer()
    )
  );

-- ---------------------------------------------------------------------------
-- Deliberately NOT tenant-scoped
-- ---------------------------------------------------------------------------
-- `fx_rates` holds published market data keyed by (as_of, currency, source). It
-- carries no issuer column because a rate is not anyone's private information,
-- and every issuer converting EUR on the same date must use the same figure.
-- Partitioning it per tenant would let two issuers' reports disagree about a
-- public exchange rate.

-- Supporting indexes: each policy filters on issuer_id, so every scoped query
-- gains that predicate. These make the added predicate cheap.
CREATE INDEX IF NOT EXISTS custodians_issuer_idx          ON custodians (issuer_id);
CREATE INDEX IF NOT EXISTS token_deployments_issuer_idx   ON token_deployments (issuer_id);
CREATE INDEX IF NOT EXISTS reporting_periods_issuer_idx   ON reporting_periods (issuer_id);
CREATE INDEX IF NOT EXISTS anchors_issuer_idx             ON anchors (issuer_id);
CREATE INDEX IF NOT EXISTS source_documents_issuer_idx    ON source_documents (issuer_id);
CREATE INDEX IF NOT EXISTS report_versions_period_idx     ON report_versions (period_id);
CREATE INDEX IF NOT EXISTS approvals_version_idx          ON approvals (report_version_id);

COMMIT;
