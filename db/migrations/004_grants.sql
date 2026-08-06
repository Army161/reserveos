-- Grants for objects added in 003.
--
-- `source_documents` is evidentiary: INSERT and SELECT only, with a narrow
-- UPDATE for the status transition a rejected or superseded document needs.
-- Nothing may rewrite the filename, the content hash, or the byte count.
--
-- Note what is deliberately NOT granted: UPDATE on `fx_rates`. An earlier
-- version of the FX store used `ON CONFLICT DO UPDATE`, which Postgres rejects
-- at plan time without UPDATE privilege — so it failed in production while
-- passing every test, because the test harness connects as the owner. The fix
-- was to make rate recording append-only rather than to widen the grant: an
-- overwritten rate would change the total of an already-certified report and
-- break its hash.

BEGIN;

GRANT SELECT, INSERT ON source_documents TO reserveos_app;
GRANT UPDATE (status, rejection_reason, statement_as_of, row_count)
  ON source_documents TO reserveos_app;

GRANT SELECT ON source_documents TO reserveos_readonly;

COMMIT;
