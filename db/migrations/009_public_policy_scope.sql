-- Confine the public-verification policies to sessions actually running as
-- `reserveos_public`.
--
-- The leak this closes, which was self-inflicted by 006. That migration granted
-- `reserveos_public` TO `reserveos_app` so the API could downgrade itself with
-- SET LOCAL ROLE for the unauthenticated verification endpoint. But Postgres
-- matches a policy's role list by MEMBERSHIP, not by the role the session is
-- currently running as — `pg_has_role('reserveos_app','reserveos_public','MEMBER')`
-- is true — so every `TO reserveos_public` policy also applied to the ordinary
-- authenticated app role.
--
-- Permissive policies on a table are OR'd together. The tenant policy from 005
-- said "rows belonging to app.issuer_id"; the public policy said "rows of any
-- PUBLISHED period". Together they said "your own rows, OR anyone's published
-- ones" — so an authenticated user of one issuer could read another issuer's
-- published periods, report versions, anchors and legal name. Verified before
-- this migration: a session scoped to one issuer returned a different issuer's
-- PUBLISHED period.
--
-- `current_user` is the role the session is EXECUTING as, which SET LOCAL ROLE
-- changes and mere membership does not. Adding it to each USING clause makes the
-- policies mean what their name always claimed: rules for the public endpoint,
-- not extra reach for everybody who can reach the public endpoint.
--
-- The application layer also checks period ownership when resolving a report
-- version (`loadOwnedPeriod` in src/services/period.ts). That check stays: this
-- is the same belt-and-braces as everywhere else, and it is the database's job
-- to be the one that cannot be forgotten.

BEGIN;

DROP POLICY IF EXISTS reporting_periods_published ON reporting_periods;
CREATE POLICY reporting_periods_published ON reporting_periods
  FOR SELECT TO reserveos_public
  USING (current_user = 'reserveos_public' AND status = 'PUBLISHED');

DROP POLICY IF EXISTS report_versions_published ON report_versions;
CREATE POLICY report_versions_published ON report_versions
  FOR SELECT TO reserveos_public
  USING (
    current_user = 'reserveos_public'
    AND EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.id = report_versions.period_id
         AND p.status = 'PUBLISHED'
    )
  );

DROP POLICY IF EXISTS anchors_published ON anchors;
CREATE POLICY anchors_published ON anchors
  FOR SELECT TO reserveos_public
  USING (
    current_user = 'reserveos_public'
    AND subject_type = 'REPORT_VERSION'
    AND EXISTS (
      SELECT 1 FROM report_versions v
       JOIN reporting_periods p ON p.id = v.period_id
       WHERE v.id = anchors.subject_id
         AND p.status = 'PUBLISHED'
    )
  );

DROP POLICY IF EXISTS issuers_published ON issuers;
CREATE POLICY issuers_published ON issuers
  FOR SELECT TO reserveos_public
  USING (
    current_user = 'reserveos_public'
    AND EXISTS (
      SELECT 1 FROM reporting_periods p
       WHERE p.issuer_id = issuers.id
         AND p.status = 'PUBLISHED'
    )
  );

COMMIT;
