# ReserveOS

Stablecoin reserve and compliance operations, built on Kaleido.

Runs the monthly compliance cycle that the GENIUS Act requires of permitted payment stablecoin issuers: continuous reserve monitoring, automated assembly of the statutory monthly reserve report, redemption-SLA tracking, a four-stage CEO/CFO certification workflow, and a blockchain-anchored evidence trail an examiner can verify without trusting us.

- [`plan.md`](plan.md) — strategy, market research, business model
- [`build-v1.md`](build-v1.md) — V1 specification and build sequence

## Status

V1 in progress. The domain core is complete and tested; the platform integration is stubbed behind an interface pending the Kaleido provisioning spike.

| Area | State |
|---|---|
| Money and ratio arithmetic | Done — exact integer, no floats |
| Canonical JSON + hashing + Merkle | Done |
| Reconciliation engine and compliance rules | Done |
| Report assembly and public disclosure | Done |
| Evidence anchoring service | Done against a fake client |
| Certification workflow | Done against a fake client |
| Redemption SLA and business calendar | Done |
| `EvidenceAnchor` contract | Compiles; needs on-chain integration test |
| Database schema and migrations | Done — migration runner with drift detection |
| Postgres stores | Done — verified against a real Postgres |
| CSV parsing and statement mapping | Done — RFC 4180, strict value parsing |
| Statement ingestion worker | Done — transactional, with source-document lineage |
| Supply observation worker | Done against a fake client |
| SFTP transport adapter | Done — verified against a real SSH server, host key pinned |
| Tenant isolation | Done — Postgres row-level security, verified under an unprivileged role |
| HTTP API | Done — bearer auth, RBAC, step-up, problem+json |
| Examiner portal | Done — browser-side verification, checked in a real browser |
| Operator console | Done — full cycle driven through it in a real browser |
| Kaleido platform client | Interface + fake only — real implementation blocked on credentials |

912 tests passing. Database and SFTP tests skip automatically when their Docker services are not reachable.

## Quick start

```bash
npm install
```

```bash
npm test
```

```bash
npm run demo
```

`npm run demo` prints a complete sample monthly report from the test fixtures, with its canonical hash.

To compile the Solidity:

```bash
npm run contracts:build
```

Database tests need a local Postgres:

```bash
npm run db:up
```

```bash
npm run db:migrate
```

SFTP tests need an SSH server. They read its host key fingerprint from the running container, so no configuration is needed:

```bash
npm run sftp:up
```

Both suites skip cleanly when their service is absent, so `npm test` works on a machine without Docker.

To run the API, copy `.env.example` to `.env` and set `DATABASE_URL`:

```bash
npm run build
```

```bash
npm start
```

`npm start` loads `.env` if it is present and ignores its absence, so a deployment that injects the environment directly needs no file. Point `DATABASE_URL` at a login role granted `reserveos_app`, never at the superuser or the schema owner — both bypass row-level security, and the server will start perfectly well with tenant isolation silently disabled. Migrations and `seed:demo` are the exception and want the owner, so they read `DATABASE_URL` from the environment rather than from `.env`.

## Layout

```
src/domain/       Pure logic. No I/O, no clock reads, no floats.
  types.ts          Facts, computations, breaches
  money.ts          Exact integer money, FX, tenor, ratio formatting
  canonical.ts      RFC 8785 canonical JSON, SHA-256, Merkle roots
  reconciliation.ts computePeriod — the core engine
  rules.ts          Compliance thresholds and breach evaluation
  report.ts         Statutory report assembly
  calendar.ts       Business-day arithmetic for the SLA clock

src/db/           Persistence. Every store takes a Pool or a PoolClient, so
  types.ts          any of them composes into a caller's transaction.
  pool.ts           Type-parser overrides, pool, withTransaction
  rows.ts           Row -> domain mappers
  stores/facts.ts       Reserve facts, supply facts, FX rates
  stores/workflow.ts    Anchors, approvals, redemptions
  stores/reference.ts   Issuers, custodians, token deployments
  stores/reports.ts     Reporting periods and report versions
  stores/documents.ts   Source-document lineage

src/ingest/       Getting custodian and chain data in
  csv.ts            Strict RFC 4180 parser, no dependencies
  mapping.ts        Amount/date/category/CUSIP parsing, per-custodian mapping
  source.ts         StatementSource seam + local-filesystem implementation
  sftp.ts           SFTP transport with mandatory host key pinning
  statement-worker.ts  fetch -> hash -> parse -> map -> persist, transactionally
  supply-worker.ts     Polls totalSupply() per deployment

src/kaleido/      The single seam onto the Kaleido platform
  client.ts         Interface
  fake.ts           In-memory implementation for tests

src/services/     Orchestration
  evidence.ts       Anchoring, idempotency, retry
  certification.ts  Four-stage approval workflow
  redemption.ts     SLA tracking and period summary

src/api/          HTTP surface
  server.ts         App factory, auth hook, tenant helper, error mapping
  auth.ts           Bearer tokens (stored hashed), roles, step-up
  errors.ts         RFC 9457 problem+json
  routes/           issuer, periods, certification, verify

src/portal/       The examiner portal. Static, dependency-free, readable.
  index.html        The page
  app.mjs           Page behaviour
  verify-client.mjs Hash recomputation — shipped to the browser AND tested
                    against the server implementation

src/operator/     The operator console. Same approach: no framework, no build.
  index.html        Shell and styles
  app.mjs           Router and views
  api.mjs           Fetch client; never coerces a money string to a number
  ui.mjs            DOM builders (no innerHTML anywhere) and formatting

contracts/        EvidenceAnchor.sol — append-only commitment log
db/migrations/    Schema, privilege grants, integrity constraints, RLS,
                  four-eyes constraint, public-policy scoping
scripts/migrate.ts  Migration runner; refuses an edited applied migration
test/             912 tests
```

## The operator console

At `/operator`. Dashboard, periods, live reconciliation, the certification chain, ingestion audit, and redemption SLAs.

```bash
npm run seed:demo
```

prints a token per role. The whole cycle has been driven through the console in a real browser: sign in → generate a report → four signatures by four different people, with step-up demanded from both executives → publish → verify the result in the examiner portal.

Two rules shape it. **The console must never let a signer discover a problem at the moment of signing** — an open critical breach disables certification with the reason on screen, a missing step-up is stated up front, and the statutory attestation wording is shown verbatim before the button becomes live. If the wording cannot be loaded, signing stays disabled rather than falling back to a placeholder: nobody should certify a statement they have not read.

**Nothing is ever assigned to `innerHTML`.** Every node is built with `createElement` and every string arrives as a text node, so a custodian name or a breach message read out of the database cannot become markup. The CSP would block an injected script but not injected content, and a fabricated "PASS" badge would do more damage than a script.

Amounts are formatted by string manipulation. `Number(x).toLocaleString()` would be shorter and would silently round anything above 2^53, which token supply routinely exceeds.

## The examiner portal

```bash
npm run seed:demo
```

```bash
npm start
```

Then open `http://127.0.0.1:3000/portal` and paste the hash the seed script printed.

The point of this page is what it does *not* do. The server never returns a `verified: true` field, because a server asserting its own correctness proves nothing. `/verify/:hash` returns the published disclosure, the hashes, and the ledger commitment; the browser recomputes all of it and compares. The verification module is served as readable source rather than a bundle, so an examiner can read the code their browser just ran.

The ledger commitment is a Merkle root over **two** leaves — the certified report hash and the disclosure hash. Anchoring only the report hash would leave the published figures uncommitted: anyone could serve different figures citing the same private report, and nobody without the full report could tell.

One step is deliberately not presented as a check that passed: confirming the anchoring transaction is really on the ledger. The page shows the transaction hash and tells the examiner to look it up themselves, because that is the one claim it cannot settle on its own.

## Design rules

These are load-bearing. Breaking one is a correctness or evidentiary failure, not a style issue.

**Money never touches a float.** All amounts are `bigint` minor units; token supply is `bigint` unscaled uint256. A 10-billion-token supply at 18 decimals exceeds `Number.MAX_SAFE_INTEGER` by ten orders of magnitude, and a wrong figure on a certified report is a regulatory event with personal criminal exposure attached to someone's signature.

**Canonical payloads contain no JSON numbers.** Every quantity is serialized as a string. This sidesteps RFC 8785's number-serialization rules entirely — the one part of the spec where two implementations can silently disagree and produce different hashes for the same logical document, which would break independent verification.

**`computePeriod` is pure and deterministic.** No clock reads, no iteration over unordered collections. Recomputing a historical period from stored facts reproduces its original hash exactly. `test/determinism.test.ts` enforces this and is the regression net for the whole product — treat a failure there as a release blocker, never as a snapshot to update.

**A signature binds the stored payload, never a live recomputation.** `report_versions.payload` is the snapshot taken at generation, and it is the document that gets hashed, signed, anchored and published. Recomputing from current facts is the right way to ask whether a version is still fit to certify, but the answer must be compared against the payload rather than substituted for it: `listCurrentAsOf` takes the latest non-superseded fact per custodian, so one corrected statement changes the recomputation while the stored payload stands still. Anything a signer reads, and anything that gates their signature, comes from the payload.

**Facts are append-only, enforced by database privilege.** The application role holds no `UPDATE` or `DELETE` on `reserve_facts`, `supply_facts`, `report_versions`, or `approvals`. The single permitted mutation is setting `superseded_by`. Verified in the schema, not just intended.

**A custodian statement is a complete position snapshot.** Reconciliation selects the latest `as_of` per custodian rather than summing across statement dates. Summing would double-count every holding.

**Missing data is a critical breach, never a zero.** A missing supply observation understates outstanding tokens and inflates the collateralization ratio; an unpriceable currency understates reserves. Both refuse to certify rather than quietly producing a wrong headline figure.

**The chain stores hashes, never content.** Reserve positions are commercially sensitive. Besu holds commitments; content stays in Postgres and object storage.

**Dates are UTC at the driver boundary.** `pg` parses a `DATE` into a *local-midnight* JS Date, so on a host east of UTC `'2026-05-15'` reads back as calendar day 14. That would shift every maturity by a day and flip an instrument sitting on the 93-day statutory boundary in or out of breach depending on which region the server runs in — passing CI in a US timezone and misreporting in Frankfurt. Closed with a custom type parser on read and `toDateParam` on write.

**Timestamps are millisecond-precision, by column type.** Postgres stores microseconds; the driver truncates to milliseconds. A timestamp that changes on reload would break a certified report's own hash, so every `TIMESTAMPTZ` is `TIMESTAMPTZ(3)`.

**FX rates are immutable once recorded.** Not an upsert. Overwriting a rate would change the total of an already-certified report and break its hash. A restatement is recorded under a distinct `source`, making the substitution explicit. (This also happens to be the only form the privilege model allows — `ON CONFLICT DO UPDATE` needs UPDATE, which the append-only grants withhold.)

**A policy's role list is about membership, not the current role.** Postgres applies a `TO some_role` policy to anyone who is a *member* of that role. Since the API is a member of `reserveos_public` in order to `SET ROLE` onto it, every public policy must also test `current_user = 'reserveos_public'` — otherwise it silently widens ordinary authenticated traffic. Permissive policies are OR'd, so one over-broad policy defeats a correct one.

**Tenant isolation is a database policy, not a `WHERE` clause.** Several store methods take a bare id (`getPeriod(id)`, `findByHash(hash)`) because that is what their callers need. Filtering by `issuer_id` in application code would make isolation depend on every future method remembering to do it. Row-level security (migration 005) means a query that omits the predicate returns nothing rather than another issuer's positions. The application must connect as `reserveos_app`; superusers and the schema owner bypass RLS, which is what migrations and the test harness rely on.

**The issuer is taken from the authenticated principal, never from the request.** No body field, query parameter, or path segment selects a tenant. Even if a handler tried, row-level security would return nothing.

**Roles are compared as arrays, never as strings.** A Postgres `user_role[]` arrives from the driver as the literal text `'{PREPARER}'`, which turns `roles.includes('CEO')` into a substring test. The query casts to `text[]` and authentication throws if the result is not an array.

**The SFTP host key is pinned, with no opt-out.** `ssh2` accepts any host key when no verifier is supplied, and the payload is a bank's complete reserve position, so the fingerprint is a required constructor argument rather than an option.

**Hash columns are `TEXT` with a format `CHECK`, never `CHAR(64)`.** `CHAR(n)` blank-pads, so a short hash reads back as a well-formed 64-character string and any length check on read passes. This independently produced two defects — a padded Merkle root would have been anchored on-chain, and `bpchar` comparison ignoring trailing blanks meant lookup-by-hash still matched the corrupted row and hid the damage.

## What blocks completion

The Kaleido client has only a fake implementation. Writing the real one needs an account and the week-1 provisioning spike described in `build-v1.md` §4 — public Terraform documentation enumerates the `platform_*` resources but leaves most service `type` strings and `config_json` shapes as passthrough, so those must be read back from a live environment rather than guessed.

Outstanding before a design partner can run a real cycle: the SFTP transport adapter (the `StatementSource` interface is the only thing it needs to implement), the HTTP API, and the examiner portal.

## What the security review found

An adversarial review ran over authentication, tenancy, the public disclosure endpoint and the console. The findings worth knowing about, because each one shaped a design rule above:

**Public-verification policies widened every authenticated session.** Migration 006 granted `reserveos_public` to `reserveos_app` so the API could `SET LOCAL ROLE` for the unauthenticated endpoint. Postgres matches a policy's role list by *membership*, not by the role the session is executing as — so every `TO reserveos_public` policy also applied to ordinary authenticated traffic. Permissive policies are OR'd, so "your own rows" quietly became "your own rows, or anyone's published ones", and one issuer could read another's published periods, report versions, anchors and legal name. Migration 009 gates each policy on `current_user = 'reserveos_public'`, which `SET ROLE` satisfies and membership does not.

**One credential could complete the whole four-eyes chain.** The stage check asked only which *role* signed last, never who. A user holding all four roles walked PREPARER→COMPLIANCE→CFO→CEO alone and produced a report bearing four statutory signatures from one human. Fixed in `CertificationService` — the invariant belongs to the approval chain, not to whichever caller happens to be today's — and backstopped by `UNIQUE (report_version_id, actor_id)` in migration 008, which is the only layer that survives two concurrent requests.

**Step-up had no lower bound.** `now - step_up_at < VALIDITY` is satisfied by any *future* stamp, and the stamp was written with the database clock while being read against the API process clock, so any positive skew extended proof-of-presence indefinitely.

**A malformed body from an anonymous caller produced a 500.** Fastify rejects an unparseable body during parsing, before the hook that authenticates, so those errors reached the generic handler and were mapped to 500 — including oversized bodies, which defeated the `bodyLimit` control. Each one also logged at error level with a stack, letting an unauthenticated caller drive error logging with a single malformed byte.

**Every verification check compared the response against itself.** A malicious server could serve a wholly invented but internally consistent document and pass all of them. `verifyResponse` now requires the hash the examiner brought from the signed report — the one value the server did not choose.

**The console mislabelled timestamps.** `formatDateTime` sliced characters out of an ISO string and appended " UTC", so an offset timestamp rendered two hours wrong and confidently labelled, and arbitrary text passed through as `garbage  UTC`.

**A signature could be recorded against a version the facts had outrun.** `POST /api/reports/:id/approvals` recomputed the period before admitting a decision — sound, since a signer is answering whether the figures are correct now — but never compared the result to `version.payload`, which is what actually gets signed, hashed, anchored and published. The gate asked its question of one document and recorded the answer against another. A version generated while a chain's supply observation was missing therefore collected all four statutory signatures, both executive attestations included, because the gate was reading clean recomputed figures while the payload carried a CRITICAL `NO_SUPPLY_OBSERVATION` breach and an inflated 150% collateralization ratio — and the published disclosure then served the stale figures. Certification now refuses with a 409 naming regeneration as the way forward, at any stage of the chain rather than only the first; a `REJECTED` decision is still admitted, so a stale version can be cleared instead of trapped.

**The certification screen rendered figures the signature did not cover.** The console drew the certify view from `GET /api/periods/:id/computation`, a live recomputation, and printed it directly beneath the frozen payload hash. The two diverge the moment a corrected custodian statement arrives, which is the ordinary month-end flow, so a CFO could read one document and sign another. Worse, the breach gate read the same live source: the recomputation showing no open breach unlocked the button for a payload that carried a critical one. The view now reads `report.payload` and nothing else, and no longer requests the computation endpoint at all. A malformed payload renders the em-dash placeholder rather than a coerced number — a dash sends a signer to look, a plausible figure does not.

## Known gaps

- **`redemption_requests.breach_reason` is still unwritten.** `build-v1.md` requires breach counts *with reasons*; the column and a `breached_at` timestamp exist, but `RedemptionRequest` has no reason field yet, so the report pack cannot populate it.
- **Certification and evidence services are not yet tenant-wired.** `EvidenceService` and `CertificationService` take a store rather than a pool, so the caller must wrap them in `withTenant`. The ingestion and supply workers do this themselves; these two will need it once an API layer calls them.
- **SFTP credentials are read from config, not a secret manager.** `custodians.connector_config` is documented as holding secrets *by reference*, but nothing yet resolves those references.
- **Signing is a placeholder.** The certification route produces a deterministic string binding actor, payload hash and attestation wording. It is not a cryptographic signature — that routes to the Kaleido Key Manager once credentials exist, so the private key never reaches the application process.
- **Step-up is stubbed.** `POST /api/auth/step-up` stamps the token; a deployment verifies a WebAuthn assertion first. The freshness window and the executive-signing check around it are real.
- **No rate limiting.** `/verify/:hash` and `/verify/canonicalize` are unauthenticated and uncapped.
- **The console holds its bearer token in `sessionStorage`.** It dies with the tab, and the page's CSP forbids inline and third-party script, but it is still readable by any script on this origin. The durable answer is an httpOnly cookie plus CSRF protection.
- **Anchor `update` is last-write-wins except for status.** `CONFIRMED` is now terminal, but two concurrent sweeps can still interleave the other columns. Harmless today because only the sweep writes them.
- **Domain fixtures use invalid CUSIP check digits.** Harmless — `test/fixtures.ts` values never pass through `parseCusip` — but changing them would move the pinned determinism hash, so they were left alone deliberately.
