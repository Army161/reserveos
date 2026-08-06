-- One signature per person per report version.
--
-- The certification chain has four stages and its value is that four different
-- people look at the figures. Until now that was enforced only by reading the
-- existing approvals and checking the actor is not among them — first in the
-- HTTP route, later in `CertificationService`.
--
-- Both of those are read-then-write. Two requests carrying the same credential,
-- arriving together, can both read a chain that does not yet contain the actor
-- and both insert. The application check cannot close that window; a UNIQUE
-- index can, because the second INSERT fails no matter how the two interleave.
--
-- This is the same reasoning as the append-only grants in 002 and the row-level
-- security in 005: where an invariant is load-bearing, the database enforces it
-- and the application layer merely reports it nicely. Here the invariant is that
-- a report bearing four statutory signatures had four humans behind it — two of
-- them accepting personal criminal liability.
--
-- The existing UNIQUE (report_version_id, role) remains: it stops one stage being
-- signed twice. This one stops one person signing two stages. Neither implies
-- the other.

BEGIN;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_one_decision_per_actor
  UNIQUE (report_version_id, actor_id);

COMMIT;
