# ReserveOS V1 — Build Specification

**Scope:** the smallest system that can run one issuer's real monthly GENIUS Act compliance cycle end to end.
**Target:** 12 working weeks to design-partner production.
**Companion document:** `plan.md` (strategy, market, business model).

---

## 1. V1 Goal

One sentence: **an issuer connects a custodian feed and a token contract, and thirty days later their CFO signs a report pack that an examiner can independently verify was not altered after signature.**

### In scope

- Ingestion from custodian data (file-based first, API where available) and on-chain token supply across EVM chains
- A reconciliation engine computing reserve composition, weighted average tenor, custody geography, outstanding supply, and collateralization ratio
- Continuous rule evaluation with alerting on eligibility, tenor, concentration, and collateralization breaches
- Monthly report-pack generation matching the Section 4(a)(1)(C) disclosure schedule
- A four-stage certification workflow ending in CEO/CFO attestation
- Cryptographic evidence anchoring to a permissioned Besu chain on Kaleido
- A read-only examiner and auditor portal with independent verification
- Redemption request tracking against the two-business-day standard

### Explicitly out of scope for V1

MiCA report formats (Phase 3), ERP and accounting-system connectors (product 2), multi-issuer shared networks and Paladin privacy domains (Phase 4), non-EVM chains beyond a stub interface, automated custodian API onboarding (manual per-connector for now), and mobile clients.

### Definition of done

A design partner runs a full monthly cycle on real data. The output pack is accepted by a PCAOB-registered examining firm as a usable input. An independent party, given only the public anchor and the report, can verify the report is byte-identical to what was certified.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                          │
│  Issuer console (Next.js)   Examiner portal (Next.js, read-only)  │
└───────────────────────────┬──────────────────────────────────────┘
                            │  REST + WebSocket, OIDC-authenticated
┌───────────────────────────▼──────────────────────────────────────┐
│  RESERVEOS APPLICATION (our code — Node.js / TypeScript)          │
│                                                                   │
│  ┌────────────┐ ┌─────────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Ingestion  │ │Reconciliation│ │  Report  │ │   Evidence     │  │
│  │  workers   │→│    engine    │→│ assembly │→│    service     │  │
│  └────────────┘ └─────────────┘ └──────────┘ └───────┬────────┘  │
│         │              │              │              │            │
│  ┌──────▼──────────────▼──────────────▼──────────────▼────────┐  │
│  │  PostgreSQL — append-only facts, computed periods,          │  │
│  │  report versions, approvals, anchor receipts                │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────────┘
                            │  Kaleido SDK / REST
┌───────────────────────────▼──────────────────────────────────────┐
│  KALEIDO PLATFORM                                                 │
│                                                                   │
│  Connectors ──── multi-chain token supply (EVM)                   │
│  FireFly ─────── orchestration, contract listeners, event bus     │
│  CMS ─────────── EvidenceAnchor contract build/deploy/API         │
│  TMS ─────────── reliable anchor tx submission (nonce, gas, retry)│
│  KMS ─────────── anchoring keys (optionally CloudHSM-bound)       │
│  PMS ─────────── OPA policy: four-eyes + executive sign-off       │
│  Besu ────────── permissioned evidence chain                      │
│  Public Tether ─ periodic state proof → public Ethereum           │
└──────────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │ Custodian feeds (SFTP/API)│
              │ Public chains (RPC)        │
              └───────────────────────────┘
```

### Design principles

**Facts are append-only.** Nothing is ever updated in place. A corrected custodian balance is a new fact superseding an earlier one, with both retained. This is non-negotiable: the entire product value is being able to reconstruct what was known at the moment of signature.

**Every figure is traceable.** Each number in a report pack carries a lineage reference to the specific facts that produced it. A CFO asked "where does this come from" gets an answer in two clicks, not two days.

**The chain stores hashes, never data.** Reserve positions and custodian statements are commercially sensitive. Besu holds only hashes, timestamps, and signatures; content lives in Postgres and object storage. This mirrors Kaleido's own Document Store design.

**Kaleido does the distributed-systems work.** We do not write nonce management, retry logic, event checkpointing, or key custody. Those are TMS, FireFly event streams, and KMS respectively. Our code is domain logic.

---

## 3. Data Model

Core tables, PostgreSQL.

```sql
-- Tenancy
CREATE TABLE issuers (
  id UUID PRIMARY KEY,
  legal_name TEXT NOT NULL,
  regulator TEXT NOT NULL,              -- 'OCC' | 'STATE_NY' | ...
  kaleido_env_id TEXT NOT NULL,         -- Kaleido environment
  anchor_contract_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What the issuer has issued
CREATE TABLE token_deployments (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals SMALLINT NOT NULL,
  kaleido_connector_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (chain_id, contract_address)
);

-- Where the reserves are
CREATE TABLE custodians (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  name TEXT NOT NULL,
  jurisdiction CHAR(2) NOT NULL,        -- ISO 3166-1, for custody geography
  connector_type TEXT NOT NULL,         -- 'sftp_csv' | 'api_rest' | 'manual'
  connector_config JSONB NOT NULL       -- secrets by reference, never inline
);

-- APPEND-ONLY. The evidentiary spine.
CREATE TABLE reserve_facts (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  custodian_id UUID NOT NULL REFERENCES custodians(id),
  as_of TIMESTAMPTZ NOT NULL,           -- custodian's stated time
  observed_at TIMESTAMPTZ NOT NULL,     -- when we ingested it
  instrument_category TEXT NOT NULL,    -- 'CASH' | 'FED_DEPOSIT' | 'TBILL' | 'MMF' | 'REPO' | 'OTHER'
  cusip TEXT,
  face_value_cents BIGINT NOT NULL,
  market_value_cents BIGINT NOT NULL,
  maturity_date DATE,                   -- drives the 93-day tenor test
  source_document_id UUID,              -- object-storage reference
  source_hash CHAR(64) NOT NULL,        -- SHA-256 of raw source
  superseded_by UUID REFERENCES reserve_facts(id),
  CHECK (market_value_cents >= 0)
);
CREATE INDEX ON reserve_facts (issuer_id, as_of DESC) WHERE superseded_by IS NULL;

-- APPEND-ONLY. On-chain observations.
CREATE TABLE supply_facts (
  id UUID PRIMARY KEY,
  token_deployment_id UUID NOT NULL REFERENCES token_deployments(id),
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ NOT NULL,
  total_supply NUMERIC(78,0) NOT NULL,  -- uint256, unscaled
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (token_deployment_id, block_number)
);

-- Computed, reproducible from facts
CREATE TABLE reporting_periods (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL,                 -- 'OPEN'|'IN_REVIEW'|'CERTIFIED'|'PUBLISHED'
  UNIQUE (issuer_id, period_end)
);

CREATE TABLE report_versions (
  id UUID PRIMARY KEY,
  period_id UUID NOT NULL REFERENCES reporting_periods(id),
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,               -- canonical report document
  payload_hash CHAR(64) NOT NULL,       -- SHA-256 of RFC 8785 canonical JSON
  generated_at TIMESTAMPTZ NOT NULL,
  generated_by UUID NOT NULL,
  UNIQUE (period_id, version)
);

-- The certification chain
CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  report_version_id UUID NOT NULL REFERENCES report_versions(id),
  role TEXT NOT NULL,                   -- 'PREPARER'|'COMPLIANCE'|'CFO'|'CEO'
  actor_id UUID NOT NULL,
  actor_email TEXT NOT NULL,
  decision TEXT NOT NULL,               -- 'APPROVED'|'REJECTED'
  attestation_text TEXT NOT NULL,       -- exact wording the signer saw
  signature TEXT NOT NULL,              -- over payload_hash
  signed_at TIMESTAMPTZ NOT NULL,
  pms_decision_id TEXT                  -- Kaleido Policy Manager reference
);

-- Proof it existed and has not changed
CREATE TABLE anchors (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  subject_type TEXT NOT NULL,           -- 'DAILY_ROLLUP'|'REPORT_VERSION'|'APPROVAL'
  subject_id UUID NOT NULL,
  merkle_root CHAR(64) NOT NULL,
  besu_tx_hash TEXT,
  besu_block_number BIGINT,
  public_tether_ref TEXT,               -- public Ethereum state proof
  anchored_at TIMESTAMPTZ,
  status TEXT NOT NULL                  -- 'PENDING'|'CONFIRMED'|'FAILED'
);

-- Redemption SLA clock
CREATE TABLE redemption_requests (
  id UUID PRIMARY KEY,
  issuer_id UUID NOT NULL REFERENCES issuers(id),
  external_ref TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  amount_cents BIGINT NOT NULL,
  sla_deadline TIMESTAMPTZ NOT NULL,    -- +2 business days, issuer calendar
  settled_at TIMESTAMPTZ,
  status TEXT NOT NULL,                 -- 'RECEIVED'|'PROCESSING'|'SETTLED'|'REJECTED'|'BREACHED'
  breach_reason TEXT
);
```

**Multi-tenancy:** row-level security on `issuer_id` for the shared-tenant tier; separate database and separate Kaleido environment for Institution-tier customers.

---

## 4. Kaleido Provisioning

Everything is Terraform, using the `kaleido-io/kaleido` provider. This is per-tenant and repeatable — onboarding a new issuer is a `terraform apply` against a new variable file, not a runbook.

```hcl
terraform {
  required_providers {
    kaleido = { source = "kaleido-io/kaleido", version = "~> 1.2" }
  }
}

variable "issuer_slug" { type = string }

# --- Environment ---------------------------------------------------
resource "kaleido_platform_environment" "issuer" {
  name = "reserveos-${var.issuer_slug}"
}

resource "kaleido_platform_network" "evidence" {
  environment = kaleido_platform_environment.issuer.id
  type        = "Besu"
  name        = "evidence-chain"
  config_json = jsonencode({
    consensus  = "qbft"
    chainId    = 138000 + var.chain_offset
    blockPeriod = 5
  })
}

# --- Besu validator runtimes --------------------------------------
resource "kaleido_platform_runtime" "besu" {
  count       = 3
  environment = kaleido_platform_environment.issuer.id
  type        = "BesuNode"
  name        = "validator-${count.index}"
  config_json = jsonencode({ size = "small" })
}

resource "kaleido_platform_service" "besu" {
  count        = 3
  environment  = kaleido_platform_environment.issuer.id
  runtime      = kaleido_platform_runtime.besu[count.index].id
  type         = "BesuNode"
  name         = "validator-${count.index}"
  config_json  = jsonencode({ network = { id = kaleido_platform_network.evidence.id } })
}

# --- Key Manager ---------------------------------------------------
resource "kaleido_platform_runtime" "kms" {
  environment = kaleido_platform_environment.issuer.id
  type        = "KeyManager"
  name        = "kms"
  config_json = jsonencode({})
}

resource "kaleido_platform_service" "kms" {
  environment = kaleido_platform_environment.issuer.id
  runtime     = kaleido_platform_runtime.kms.id
  type        = "KeyManager"
  name        = "kms"
  config_json = jsonencode({})
}

resource "kaleido_platform_kms_wallet" "anchoring" {
  environment = kaleido_platform_environment.issuer.id
  service     = kaleido_platform_service.kms.id
  type        = "hdwallet"
  name        = "anchoring-wallet"
  config_json = jsonencode({})
}

resource "kaleido_platform_kms_key" "anchor_signer" {
  environment = kaleido_platform_environment.issuer.id
  service     = kaleido_platform_service.kms.id
  wallet      = kaleido_platform_kms_wallet.anchoring.id
  path        = "m/44'/60'/0'/0/0"
  name        = "anchor-signer"
}

# --- Transaction Manager -------------------------------------------
resource "kaleido_platform_service" "tms" {
  environment = kaleido_platform_environment.issuer.id
  runtime     = kaleido_platform_runtime.tms.id
  type        = "TransactionManager"
  name        = "txmgr"
  config_json = jsonencode({
    keyManager      = { id = kaleido_platform_service.kms.id }
    blockchainConnector = { id = kaleido_platform_service.evmconnect.id }
  })
}

# --- Smart Contract Manager: build & deploy EvidenceAnchor ---------
resource "kaleido_platform_cms_build" "evidence_anchor" {
  environment = kaleido_platform_environment.issuer.id
  service     = kaleido_platform_service.cms.id
  type        = "github"
  name        = "EvidenceAnchor"
  path        = "reserveos"
  github = {
    contract_url  = "https://github.com/<org>/reserveos-contracts/blob/main/src/EvidenceAnchor.sol"
    contract_name = "EvidenceAnchor"
  }
}

resource "kaleido_platform_cms_action_deploy" "evidence_anchor" {
  environment     = kaleido_platform_environment.issuer.id
  service         = kaleido_platform_service.cms.id
  build           = kaleido_platform_cms_build.evidence_anchor.id
  name            = "deploy-evidence-anchor"
  firefly_namespace = "default"
  signing_key     = kaleido_platform_kms_key.anchor_signer.address
}

resource "kaleido_platform_cms_action_createapi" "evidence_anchor" {
  environment       = kaleido_platform_environment.issuer.id
  service           = kaleido_platform_service.cms.id
  build             = kaleido_platform_cms_build.evidence_anchor.id
  name              = "evidence-anchor-api"
  firefly_namespace = "default"
  api_name          = "evidenceanchor"
}
```

Also provisioned, following the same pattern: a `FireFly` service with a `kaleido_platform_firefly_registration`; `EVMConnect` connector services per public chain we monitor; a `kaleido_platform_identity_provider` bound to the issuer's OIDC IdP; and `kaleido_platform_pms_policy_deployment` resources carrying the certification policy.

> **Implementation note.** Public Terraform documentation enumerates the `platform_*` resources but leaves most `type` strings and `config_json` shapes as passthrough. Week 1 of the build is a provisioning spike: stand these up through the console first, read back the resulting configuration via the admin REST API, then codify the exact JSON. Do not assume the shapes above are correct without verifying against a live environment.

---

## 5. The EvidenceAnchor Contract

Deliberately minimal. Complexity in an evidence contract is risk, and every additional function is something an examiner has to be convinced about.

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EvidenceAnchor
/// @notice Append-only commitment log. Stores hashes only — never content.
contract EvidenceAnchor {
    enum SubjectType { DailyRollup, ReportVersion, Approval }

    struct Commitment {
        bytes32 merkleRoot;
        SubjectType subjectType;
        bytes32 subjectRef;   // opaque off-chain identifier
        uint64  periodEnd;    // unix day, 0 when not period-scoped
        uint64  anchoredAt;
        address submitter;
    }

    Commitment[] private _commitments;
    mapping(address => bool) public authorized;
    address public immutable owner;

    event Anchored(
        uint256 indexed index,
        bytes32 indexed merkleRoot,
        SubjectType indexed subjectType,
        bytes32 subjectRef,
        uint64  periodEnd,
        address submitter
    );
    event AuthorizationChanged(address indexed account, bool allowed);

    error NotAuthorized();
    error ZeroRoot();

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
        authorized[msg.sender] = true;
        emit AuthorizationChanged(msg.sender, true);
    }

    function setAuthorized(address account, bool allowed) external {
        if (msg.sender != owner) revert NotAuthorized();
        authorized[account] = allowed;
        emit AuthorizationChanged(account, allowed);
    }

    function anchor(
        bytes32 merkleRoot,
        SubjectType subjectType,
        bytes32 subjectRef,
        uint64  periodEnd
    ) external onlyAuthorized returns (uint256 index) {
        if (merkleRoot == bytes32(0)) revert ZeroRoot();
        index = _commitments.length;
        _commitments.push(Commitment({
            merkleRoot:  merkleRoot,
            subjectType: subjectType,
            subjectRef:  subjectRef,
            periodEnd:   periodEnd,
            anchoredAt:  uint64(block.timestamp),
            submitter:   msg.sender
        }));
        emit Anchored(index, merkleRoot, subjectType, subjectRef, periodEnd, msg.sender);
    }

    function get(uint256 index) external view returns (Commitment memory) {
        return _commitments[index];
    }

    function count() external view returns (uint256) {
        return _commitments.length;
    }
}
```

There is no update function and no delete function. That is the point.

Once deployed via CMS, `cms_action_createapi` generates an OpenAPI REST interface, so the application calls `POST /apis/evidenceanchor/anchor` with a JSON body rather than constructing transactions — and the Transaction Manager handles nonce allocation, gas, retry, and confirmation.

---

## 6. Core Application Logic

### 6.1 Ingestion

Two worker families, both writing only append-only facts.

**Custodian ingestion.** A scheduled worker per custodian connector. For `sftp_csv`: poll, download, hash the raw file, store it in object storage, parse to `reserve_facts` rows with `source_hash` set, and reject the whole file on any parse error rather than importing partial data. For `api_rest`: same shape, with the raw JSON response as the source document. Idempotency key is `(custodian_id, as_of, cusip, face_value_cents)` — re-ingesting the same statement is a no-op.

**Supply ingestion.** For each active `token_deployment`, poll `totalSupply()` through the Kaleido EVMConnect connector on a fixed cadence and write a `supply_fact` keyed by block number. Separately, register a FireFly contract listener for `Transfer` events from and to the zero address, giving a real-time mint and burn feed delivered over the FireFly event bus with at-least-once semantics and checkpointing. The polled snapshot is authoritative for reporting; the event stream drives live alerting.

```typescript
// Supply snapshot worker (abridged)
async function captureSupply(dep: TokenDeployment): Promise<void> {
  const { blockNumber, blockTimestamp, result } =
    await kaleido.connector.query(dep.kaleidoConnectorId, {
      address: dep.contractAddress,
      method: 'totalSupply',
      params: [],
    });

  await db.supplyFacts.insertIgnoreConflict({
    id: uuidv7(),
    tokenDeploymentId: dep.id,
    blockNumber,
    blockTimestamp,
    totalSupply: result as string,   // uint256 as decimal string, never a JS number
    observedAt: new Date(),
  });
}
```

`totalSupply` is a uint256. It is handled as a decimal string end to end and converted with `BigInt` only at computation boundaries. Passing it through `Number` at any point is a correctness bug that will surface as a wrong figure on a certified report.

### 6.2 Reconciliation

A pure function over facts, so any historical period can be recomputed and compared. This is what makes "reproduce the March report exactly as it was" a one-line operation.

```typescript
interface PeriodComputation {
  totalReserveValueCents: bigint;
  compositionByCategory: Record<InstrumentCategory, {
    marketValueCents: bigint;
    percentOfTotal: number;
    weightedAverageTenorDays: number;
  }>;
  custodyByJurisdiction: Record<string, bigint>;
  outstandingSupplyByChain: Record<number, bigint>;
  totalOutstandingCents: bigint;
  collateralizationRatio: number;      // reserves / outstanding
  breaches: Breach[];
}

function computePeriod(
  facts: ReserveFact[],          // latest non-superseded as of period_end
  supply: SupplyFact[],          // closest observation at or before period_end
  fx: FxRates,
  asOf: Date,
): PeriodComputation
```

Rules evaluated on every computation:

| Rule | Condition | Severity |
|---|---|---|
| Ineligible asset | category not in {CASH, FED_DEPOSIT, TBILL, MMF, REPO} | Critical |
| Tenor breach | any instrument with maturity > 93 days from `as_of` | Critical |
| Undercollateralized | ratio < 1.0000 | Critical |
| Thin buffer | ratio < 1.0025 | Warning |
| Custodian concentration | single custodian > 50% of reserves | Warning |
| Stale data | no fact from a custodian in > 48h | Warning |

Critical breaches page the compliance team immediately. The purpose is not to catch problems at month-end — it is to make month-end boring because nothing was allowed to drift for thirty days.

### 6.3 Report assembly

At period close, `computePeriod` runs, the result is rendered into the canonical report document, and the JSON is canonicalized per RFC 8785 before hashing. Canonicalization matters: without a deterministic byte representation, two systems will compute different hashes for the same logical report and independent verification collapses.

The report document carries the Section 4(a)(1)(C) schedule — total outstanding stablecoins, amount and composition of reserves by category, weighted average tenor per category, and custody geography per category — plus, for internal and examiner use, per-figure lineage to the contributing fact IDs and the redemption SLA summary for the period.

Three renderings: canonical JSON (hashed, anchored, and given to the examiner), a PDF pack for signature and filing, and a reduced public-disclosure version for the issuer's website.

### 6.4 Certification workflow

Four stages: Preparer → Compliance Reviewer → CFO → CEO. Any rejection returns the period to `OPEN` and a subsequent submission creates a new `report_version` — versions are never edited.

Kaleido's Policy Manager carries the policy (four-eyes plus executive sign-off is a documented PMS capability), and our application records the resulting decision alongside the signature. Each approval signs `payload_hash`, not a description of it, and stores the exact attestation wording displayed at signing time — so the record shows what the signer actually saw.

```typescript
async function submitApproval(
  reportVersionId: string,
  actor: AuthenticatedUser,
  role: ApprovalRole,
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  const version = await db.reportVersions.get(reportVersionId);
  requireStageIsNext(version, role);

  const attestationText = ATTESTATION_TEXT[role];   // versioned constant
  const signature = await signWithUserKey(actor, version.payloadHash, attestationText);

  const pms = await kaleido.pms.evaluate({
    policy: 'reserveos.certification',
    input: { role, actorId: actor.id, reportVersionId, decision },
  });
  if (!pms.allowed) throw new PolicyDenied(pms.reason);

  const approval = await db.approvals.insert({ /* ... */ signature, pmsDecisionId: pms.id });
  await evidence.anchorApproval(approval);

  if (role === 'CEO' && decision === 'APPROVED') {
    await db.reportingPeriods.setStatus(version.periodId, 'CERTIFIED');
    await evidence.anchorReportVersion(version);
  }
}
```

CEO and CFO approval requires step-up authentication (WebAuthn) regardless of session state. Someone is accepting personal criminal liability; a live cookie is not adequate evidence of intent.

### 6.5 Evidence anchoring

Three anchor events: a **daily rollup** (Merkle root over all facts ingested that day), a **report version** (its `payload_hash`), and an **approval** (hash of the approval record). Daily rollups are what let us prove a figure existed before the period closed, which is the difference between an evidence trail and a nicely formatted after-the-fact assertion.

```typescript
async function anchorReportVersion(v: ReportVersion): Promise<void> {
  const anchor = await db.anchors.insert({
    id: uuidv7(), issuerId: v.issuerId,
    subjectType: 'REPORT_VERSION', subjectId: v.id,
    merkleRoot: v.payloadHash, status: 'PENDING',
  });

  // CMS-generated REST API; TMS handles nonce, gas, retry, confirmation.
  const { id: opId } = await kaleido.firefly.invoke('evidenceanchor', 'anchor', {
    merkleRoot:  '0x' + v.payloadHash,
    subjectType: 1,
    subjectRef:  '0x' + uuidToBytes32(v.id),
    periodEnd:   unixDay(v.periodEnd),
  });

  await db.anchors.setPending(anchor.id, opId);
  // Confirmation arrives asynchronously via the FireFly event listener.
}
```

Anchoring is asynchronous and idempotent by `subject_id`. A pending anchor is retried; it is never assumed to have succeeded. Kaleido's Public Ethereum Tether periodically relays signed state proofs of the Besu chain to public Ethereum, so the anchor history has an external witness that neither the issuer nor we can rewrite.

### 6.6 Redemption SLA

Requests arrive by API from the issuer's redemption system, or by CSV import for issuers not yet integrated. On receipt we compute `sla_deadline` as two business days forward on the issuer's configured calendar (including their holiday schedule — getting this wrong produces false breaches, which destroys trust in the alerting fast). A scheduled evaluator warns at 75% of elapsed time, escalates at 90%, and marks `BREACHED` past the deadline. The monthly SLA summary — volume, median settlement time, breach count with reasons — is generated as part of the report pack.

### 6.7 Examiner portal

Separate application, separate authentication, strictly read-only, scoped to specific `reporting_periods` and time-boxed by grant. An examiner sees the certified report, the approval chain with timestamps and signers, the anchor references, the underlying facts with lineage, and a **verification panel**: paste or fetch the report, recompute the canonical hash in the browser, and compare against the on-chain commitment and the public Ethereum state proof.

That verification must work without trusting our servers. It is the single most persuasive thing in the product, and it should be the first thing shown in a demo.

---

## 7. Technology Choices

| Layer | Choice | Reasoning |
|---|---|---|
| Runtime | Node.js 22, TypeScript strict | Matches the Kaleido TypeScript SDK; one language across services and UI |
| API | Fastify + Zod, OpenAPI generated | Schema-first; the same schemas validate at the boundary and generate client types |
| Database | PostgreSQL 16, row-level security | Append-only patterns, exact numerics, mature audit story |
| Numerics | `bigint` and `decimal.js` | Never IEEE floats for money or token supply |
| Queue | BullMQ on Redis | Ingestion and anchoring workers; retry semantics without new infrastructure |
| Object storage | S3 with object lock | Raw source documents, WORM-protected |
| Frontend | Next.js 15, React 19, TanStack Query | Two apps: issuer console and examiner portal |
| Auth | OIDC to customer IdP via Kaleido identity provider; WebAuthn step-up | Banks require their own SSO; step-up for certification |
| Blockchain | Kaleido-managed Besu (QBFT), 3 validators | Evidence chain |
| Contracts | Solidity 0.8.24, Foundry | Foundry for local testing; CMS for build and deploy |
| Observability | OpenTelemetry, structured JSON logs | Every fact ingestion and anchor emits a span |

---

## 8. Build Sequence

**Week 1 — Provisioning spike.** Kaleido account, environment, Besu network, KMS. Stand up services through the console, read configuration back via the admin API, codify working Terraform. *Exit: `terraform apply` produces a running environment from scratch.*

**Week 2 — Contract and anchoring.** EvidenceAnchor written and tested in Foundry, deployed via CMS, REST API generated. A script anchors a hash and reads it back. *Exit: round-trip anchor verified on-chain.*

**Week 3–4 — Data layer and ingestion.** Schema and migrations. SFTP CSV connector against a real custodian sample file. Supply polling and FireFly `Transfer` listeners on a testnet token. *Exit: facts accumulating from both sources, unattended.*

**Week 5–6 — Reconciliation engine.** `computePeriod` with full unit coverage including the tenor boundary, the FX path, and the undercollateralization case. Rule evaluation and alerting. *Exit: a computed period reconciles to a hand-checked figure exactly.*

**Week 7–8 — Report assembly.** Canonical JSON with RFC 8785, lineage capture, PDF rendering, public-disclosure variant. Report versions anchored. *Exit: a generated pack reviewed against the Section 4(a)(1)(C) schedule with a design partner's compliance lead.*

**Week 9–10 — Certification workflow.** Four-stage approvals, PMS policy integration, WebAuthn step-up, approval anchoring. *Exit: a full cycle from ingestion to CEO signature, with all three anchor types on-chain.*

**Week 11 — Examiner portal and redemption SLA.** Read-only scoped access, browser-side verification panel, redemption tracking with business-day calendars. *Exit: an external reviewer verifies a certified report without our help.*

**Week 12 — Hardening.** Load testing at 10× expected fact volume. Anchor failure and recovery drills. Penetration test of the auth boundary. Runbooks. *Exit: design partner accepted for production data.*

Weeks 1–2 are the highest-risk stretch, because the public Terraform documentation does not fully specify the platform service configuration shapes. Budget for the spike genuinely rather than optimistically; if it runs long, everything downstream shifts.

---

## 9. Testing

**Correctness of computation is the product.** A wrong number on a certified report is not a bug, it is a regulatory event with personal criminal exposure attached to someone's signature. Testing is weighted accordingly.

- **Property tests** on `computePeriod`: composition percentages sum to 100 within tolerance; weighted average tenor is bounded by the minimum and maximum instrument tenor in its category; collateralization is monotone in reserve value.
- **Golden fixtures**: a set of hand-computed periods, including a leap-day period end, a period with a superseded fact, a mixed-currency period, and a period that breaches on the 93-day boundary exactly.
- **Determinism test**: recomputing a historical period from stored facts must reproduce the exact `payload_hash`. This runs in CI on every change to the engine and is the regression net for the whole product.
- **Anchor integrity test**: mutate a stored report payload by one byte and assert that verification fails.
- **Chaos**: kill the anchoring worker mid-submission and assert exactly-once anchoring on recovery; take a Besu validator offline and assert the system degrades to `PENDING` rather than losing the anchor.

---

## 10. Security

Threat model, briefly. The adversary we most care about is an **insider at the issuer** who wants to alter history after the fact — because that is the risk a regulator is actually worried about, and defending against it credibly is what we sell.

- Facts are append-only at the schema level; the application role holds no `UPDATE` or `DELETE` grant on `reserve_facts`, `supply_facts`, `report_versions`, or `approvals`.
- Daily rollup anchoring means altering a historical fact requires breaking a hash chain already committed to Besu and relayed to public Ethereum.
- Anchoring keys live in Kaleido KMS, optionally bound to the customer's own AWS CloudHSM, Azure Key Vault, or HashiCorp Vault, where keys never leave their account.
- Custodian credentials are stored by reference in a secrets manager, never in `connector_config`.
- Certification requires WebAuthn step-up; approval roles are enforced both in application logic and in PMS policy, so a single compromised layer is insufficient.
- Examiner grants are scoped to specific periods and expire automatically.
- All access to reserve data is logged with actor, scope, and time, and the access log is itself included in the daily rollup.

We pursue SOC 2 Type 1 in Phase 3. Selling continuous compliance software without our own attestation is a credibility gap that will surface in the first bank security review.

---

## 11. Open Questions

These need answers before or during the build, in rough priority order.

1. **What exactly does the examining firm want to receive?** The statute specifies disclosure content, not file format. Resolve with a PCAOB-registered firm in Phase 0 — this shapes the report module.
2. **Do target issuers have custodian API access, or only daily statement files?** Determines whether file-based ingestion is a fallback or the primary path. Assume files until proven otherwise.
3. **How are reserve market values sourced for T-bills?** Custodian-provided, or independently priced? An independent pricing feed may be a hard requirement for the examiner and is an unbudgeted dependency.
4. **Is the anchor chain per-issuer or shared?** Per-issuer is simpler and cleaner for isolation; shared is cheaper and enables cross-issuer proofs later. V1 assumes per-issuer.
5. **What is the exact PMS policy language and evaluation API?** Documented as OPA-based; the concrete interface needs confirmation during the week 1 spike.
6. **Which FX source for non-USD reserves?** Needs to be one an auditor will accept, with a retained rate history.
7. **How does the issuer's redemption system integrate?** API push, webhook, or CSV. Likely varies per customer; V1 supports CSV plus a generic API.

---

## 12. What V1 Deliberately Leaves Out

MiCA report formats, ERP connectors, non-EVM chain support beyond a stub interface, multi-issuer shared networks with Paladin privacy domains, automated custodian onboarding, mobile clients, and any form of attestation opinion.

The temptation will be to add MiCA early because the EU market is real and the code seems close. Resist it until one US issuer has completed three consecutive monthly cycles without manual intervention. A second regulatory format doubles the surface area of the thing that must be exactly right, and the first market has the harder deadline.
