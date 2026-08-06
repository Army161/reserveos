/**
 * Seed a published, verifiable reserve report for local exploration.
 *
 * Run: npm run seed:demo   (requires DATABASE_URL)
 *
 * Drives the same services the HTTP routes call, so what lands in the database
 * is what a real month produces.
 */
import { randomUUID } from 'node:crypto';
import { connectionStringFromEnv, createPool, withTenant } from '../src/db/pool.js';
import { PgReportStore } from '../src/db/stores/reports.js';
import { PgAnchorStore, PgApprovalStore } from '../src/db/stores/workflow.js';
import { EvidenceService } from '../src/services/evidence.js';
import { CertificationService, type ApprovalRole } from '../src/services/certification.js';
import { generateReportVersion, publishPeriod } from '../src/services/period.js';
import { buildPublicDisclosure } from '../src/domain/report.js';
import { merkleRoot, type CanonicalValue } from '../src/domain/canonical.js';
import { FakeKaleidoClient } from '../src/kaleido/fake.js';
import { Authenticator, type UserRole } from '../src/api/auth.js';

const ISSUER = '11111111-1111-1111-1111-111111111111';
const BNY = '22222222-2222-2222-2222-222222222221';
const SSCB = '22222222-2222-2222-2222-222222222222';
const EURO = '22222222-2222-2222-2222-222222222223';
const ETH = '33333333-3333-3333-3333-333333333331';
const BASE = '33333333-3333-3333-3333-333333333332';

const DEMO_USERS: Record<string, string> = {
  PREPARER:   '44444444-4444-4444-4444-444444444441',
  COMPLIANCE: '44444444-4444-4444-4444-444444444442',
  CFO:        '44444444-4444-4444-4444-444444444443',
  CEO:        '44444444-4444-4444-4444-444444444444',
};

const STATEMENT_AS_OF = new Date('2026-03-31T20:00:00.000Z');
const GENERATED_AT = new Date('2026-04-02T14:30:00.000Z');

const pool = createPool({ connectionString: connectionStringFromEnv() });

async function main(): Promise<void> {
  await pool.query(
    `TRUNCATE access_log, anchors, approvals, report_versions, reporting_periods,
              redemption_requests, reserve_facts, source_documents, supply_facts, fx_rates,
              api_tokens, users, token_deployments, custodians, issuers
     RESTART IDENTITY CASCADE`,
  );

  await pool.query(
    `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
     VALUES ($1, 'Acme Digital Trust Company, N.A.', 'OCC', 'env-demo')`,
    [ISSUER],
  );
  await pool.query(
    `INSERT INTO custodians (id, issuer_id, name, jurisdiction, connector_type, connector_config)
     VALUES ($1, $4, 'BNY Mellon', 'US', 'sftp_csv', '{}'),
            ($2, $4, 'State Street', 'US', 'sftp_csv', '{}'),
            ($3, $4, 'Euroclear', 'BE', 'api_rest', '{}')`,
    [BNY, SSCB, EURO, ISSUER],
  );
  await pool.query(
    `INSERT INTO token_deployments
       (id, issuer_id, chain_id, contract_address, symbol, decimals, kaleido_connector_id, active)
     VALUES ($1, $3, 1,    '0xaaaa000000000000000000000000000000000001', 'ACME', 6, 'conn-eth',  TRUE),
            ($2, $3, 8453, '0xbbbb000000000000000000000000000000000002', 'ACME', 6, 'conn-base', TRUE)`,
    [ETH, BASE, ISSUER],
  );

  await pool.query(
    `INSERT INTO reserve_facts
       (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, currency,
        face_value_minor, market_value_minor, maturity_date, source_hash)
     VALUES
       ($1, $2, $5, $5, 'CASH',  NULL,        'USD', 200000000, 200000000, NULL,         $6),
       ($1, $2, $5, $5, 'TBILL', '912797KL0', 'USD', 300000000, 300000000, '2026-05-15', $7),
       ($1, $3, $5, $5, 'TBILL', '912797MM6', 'USD', 350000000, 350000000, '2026-06-20', $8),
       ($1, $4, $5, $5, 'TBILL', '912797KL0', 'USD', 200000000, 200000000, '2026-05-15', $9)`,
    [ISSUER, BNY, SSCB, EURO, STATEMENT_AS_OF, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)],
  );

  await pool.query(
    `INSERT INTO supply_facts (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
     VALUES ($1, 21500000, $3, 7000000000000, $3),
            ($2, 12000000, $3, 3000000000000, $3)`,
    [ETH, BASE, new Date('2026-03-31T23:50:00.000Z')],
  );

  await pool.query(
    `INSERT INTO fx_rates (as_of, currency, rate_to_usd, source) VALUES ($1, 'USD', 100000000, 'ECB')`,
    [STATEMENT_AS_OF],
  );

  const kaleido = new FakeKaleidoClient();

  const hash = await withTenant(pool, ISSUER, async (client) => {
    const store = new PgReportStore(client);
    const period = await store.openPeriod(
      ISSUER,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T00:00:00.000Z'),
    );

    const generated = await generateReportVersion(client, {
      issuerId: ISSUER,
      period,
      generatedBy: ISSUER,
      generatedAt: GENERATED_AT,
      fxSource: 'ECB',
    });

    const disclosure = buildPublicDisclosure({
      payload: generated.version.payload as CanonicalValue,
      payloadHash: generated.version.payloadHash,
      canonicalJson: '',
    });

    const certification = new CertificationService({
      approvals: new PgApprovalStore(client),
      kaleido,
      evidence: new EvidenceService({
        store: new PgAnchorStore(client),
        kaleido,
        newId: () => randomUUID(),
      }),
      sign: async ({ actor, payloadHash }) => `demo:${actor.id}:${payloadHash}`,
      newId: () => randomUUID(),
      now: () => GENERATED_AT,
    });

    for (const role of ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'] as ApprovalRole[]) {
      await certification.submitApproval({
        issuerId: ISSUER,
        reportVersionId: generated.version.id,
        payloadHash: generated.version.payloadHash,
        versionCommitment: merkleRoot([generated.version.payloadHash, disclosure.payloadHash]),
        actor: {
          id: DEMO_USERS[role]!,
          email: `${role.toLowerCase()}@acme.test`,
          roles: [role],
          stepUpVerified: true,
        },
        role,
        decision: 'APPROVED',
        hasCriticalBreach: false,
      });
    }

    await store.setPeriodStatus(period.id, 'CERTIFIED');
    await publishPeriod(client, { ...period, status: 'CERTIFIED' });

    return generated.version.payloadHash;
  });

  // --- Operator accounts --------------------------------------------------
  // One user per role: the four-eyes rule refuses a chain walked by one person,
  // which is the behaviour a demo should show rather than work around.
  const authenticator = new Authenticator(pool);
  const accounts: { role: string; email: string; token: string }[] = [];

  for (const [role, email] of [
    ['PREPARER', 'prep@acme.test'],
    ['COMPLIANCE', 'compliance@acme.test'],
    ['CFO', 'cfo@acme.test'],
    ['CEO', 'ceo@acme.test'],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (issuer_id, email, display_name, roles)
       VALUES ($1, $2, $3, $4::user_role[]) RETURNING id`,
      [ISSUER, email, email, [role as UserRole]],
    );
    const issued = await authenticator.issueToken({
      userId: rows[0]!.id,
      name: 'demo',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    accounts.push({ role, email, token: issued.token });
  }

  // --- A second period, left mid-flight -----------------------------------
  // So the console has real work to show: facts ingested, nothing certified.
  const aprilAsOf = new Date('2026-04-30T20:00:00.000Z');
  await pool.query(
    `INSERT INTO reserve_facts
       (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, currency,
        face_value_minor, market_value_minor, maturity_date, source_hash)
     VALUES
       ($1, $2, $5, $5, 'CASH',  NULL,        'USD', 250000000, 250000000, NULL,         $6),
       ($1, $3, $5, $5, 'TBILL', '912797MM6', 'USD', 400000000, 400000000, '2026-06-20', $7),
       ($1, $4, $5, $5, 'TBILL', '912797KL0', 'USD', 300000000, 300000000, '2026-06-15', $8)`,
    [ISSUER, BNY, SSCB, EURO, aprilAsOf, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO supply_facts (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
     VALUES ($1, 21900000, $3, 6500000000000, $3),
            ($2, 12400000, $3, 2900000000000, $3)`,
    [ETH, BASE, new Date('2026-04-30T23:50:00.000Z')],
  );
  await pool.query(
    `INSERT INTO fx_rates (as_of, currency, rate_to_usd, source) VALUES ($1, 'USD', 100000000, 'ECB')`,
    [aprilAsOf],
  );

  await withTenant(pool, ISSUER, async (client) => {
    await new PgReportStore(client).openPeriod(
      ISSUER,
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-04-30T00:00:00.000Z'),
    );
  });

  console.log('published report hash:', hash);
  console.log(`portal:   http://127.0.0.1:3000/portal#${hash}`);
  console.log('console:  http://127.0.0.1:3000/operator');
  console.log('');
  console.log('operator tokens (one per role — four-eyes needs four people):');
  for (const account of accounts) {
    console.log(`  ${account.role.padEnd(11)} ${account.email.padEnd(24)} ${account.token}`);
  }
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
