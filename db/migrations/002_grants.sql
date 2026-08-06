-- Enforce append-only at the privilege level, not merely by convention.
--
-- The threat we most care about is an insider at the issuer altering history
-- after the fact. Application-layer discipline is not a defence against someone
-- with a database session, so the application role simply does not hold the
-- grants that would let it rewrite a fact, a report version, or an approval.
--
-- Corrections happen by INSERTing a replacement and setting `superseded_by` on
-- the original, which is why reserve_facts alone carries a narrow UPDATE grant
-- restricted to that one column.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reserveos_app') THEN
    CREATE ROLE reserveos_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reserveos_readonly') THEN
    CREATE ROLE reserveos_readonly NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO reserveos_app, reserveos_readonly;

-- Mutable configuration tables: full access.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  issuers, token_deployments, custodians
TO reserveos_app;

-- Evidentiary tables: insert and read only.
GRANT SELECT, INSERT ON
  reserve_facts, supply_facts, fx_rates, report_versions, approvals, access_log
TO reserveos_app;

-- The single permitted mutation on a fact: marking it superseded.
GRANT UPDATE (superseded_by) ON reserve_facts TO reserveos_app;

-- Workflow state must advance, so these remain updatable.
GRANT SELECT, INSERT, UPDATE ON
  reporting_periods, anchors, redemption_requests
TO reserveos_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reserveos_app;

-- Examiner / auditor role: reads nothing but what it is explicitly granted,
-- and never the raw connector configuration.
GRANT SELECT ON
  issuers, token_deployments, custodians, reserve_facts, supply_facts,
  fx_rates, reporting_periods, report_versions, approvals, anchors,
  redemption_requests
TO reserveos_readonly;

COMMIT;
