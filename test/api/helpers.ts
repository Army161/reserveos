import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../src/api/server.js';
import { Authenticator, type UserRole } from '../../src/api/auth.js';
import { FakeKaleidoClient } from '../../src/kaleido/fake.js';
import { appPool, testPool, SEED_IDS } from '../db/harness.js';

export const NOW = new Date('2026-04-02T14:30:00.000Z');

export interface TestUser {
  readonly userId: string;
  readonly token: string;
  readonly tokenId: string;
}

export interface TestServer {
  readonly app: FastifyInstance;
  readonly kaleido: FakeKaleidoClient;
  readonly pool: pg.Pool;
}

/**
 * Build a server bound to the RLS-constrained application role.
 *
 * Deliberately not the superuser pool: the API is where tenant isolation must
 * hold, and a superuser connection bypasses every policy, so these tests would
 * pass regardless of what the policies said.
 */
export async function createTestServer(now: () => Date = () => NOW): Promise<TestServer> {
  const pool = await appPool();
  const kaleido = new FakeKaleidoClient();
  const app = createServer({ pool, kaleido, now, logger: false });
  await app.ready();
  return { app, kaleido, pool };
}

/** Create a user and an active bearer token, optionally step-up verified. */
export async function seedUser(params: {
  roles: readonly UserRole[];
  issuerId?: string;
  email?: string;
  stepUp?: boolean;
  expiresAt?: Date;
  revoked?: boolean;
}): Promise<TestUser> {
  const admin = testPool();
  const issuerId = params.issuerId ?? SEED_IDS.issuerId;
  const email = params.email ?? `${params.roles.join('-').toLowerCase()}@acme.test`;

  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO users (issuer_id, email, display_name, roles)
     VALUES ($1, $2, $3, $4::user_role[]) RETURNING id`,
    [issuerId, email, email, params.roles],
  );
  const userId = rows[0]!.id;

  const authenticator = new Authenticator(admin, () => NOW);
  const issued = await authenticator.issueToken({
    userId,
    name: 'test',
    expiresAt: params.expiresAt ?? new Date('2027-01-01T00:00:00.000Z'),
  });

  if (params.stepUp === true) {
    // Stamped at the frozen clock so the freshness window is satisfied.
    await admin.query(`UPDATE api_tokens SET step_up_at = $2 WHERE id = $1`, [
      issued.tokenId,
      NOW,
    ]);
  }
  if (params.revoked === true) {
    await admin.query(`UPDATE api_tokens SET revoked_at = $2 WHERE id = $1`, [issued.tokenId, NOW]);
  }

  return { userId, token: issued.token, tokenId: issued.tokenId };
}

export function bearer(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}` };
}

/** Seed a second issuer with its own user, for cross-tenant assertions. */
export async function seedOtherIssuer(): Promise<{ issuerId: string; user: TestUser }> {
  const admin = testPool();
  const issuerId = '99999999-9999-9999-9999-999999999999';
  await admin.query(
    `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
     VALUES ($1, 'Rival Trust Co', 'NYDFS', 'env-rival')
     ON CONFLICT (id) DO NOTHING`,
    [issuerId],
  );
  const user = await seedUser({
    roles: ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'],
    issuerId,
    email: 'rival@rival.test',
  });
  return { issuerId, user };
}

/** Reserve holdings and supply sufficient for a clean, fully-backed period. */
export async function seedBackedPeriod(): Promise<void> {
  const admin = testPool();
  const asOf = new Date('2026-03-31T20:00:00.000Z');

  // Spread across three custodians so no single one holds more than half and the
  // period is genuinely clean — a concentration warning here would be a real
  // breach, not a fixture artefact.
  await admin.query(
    `INSERT INTO reserve_facts
       (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, currency,
        face_value_minor, market_value_minor, maturity_date, source_hash)
     VALUES
       ($1, $2, $3, $3, 'CASH',  NULL,        'USD', 200000000, 200000000, NULL,         $6),
       ($1, $2, $3, $3, 'TBILL', '912797KL0', 'USD', 300000000, 300000000, '2026-05-15', $7),
       ($1, $4, $3, $3, 'TBILL', '912797MM6', 'USD', 350000000, 350000000, '2026-06-20', $8),
       ($1, $5, $3, $3, 'TBILL', '912797KL0', 'USD', 200000000, 200000000, '2026-05-15', $9)`,
    [
      SEED_IDS.issuerId,
      SEED_IDS.bny,
      asOf,
      SEED_IDS.stateStreet,
      SEED_IDS.euroclear,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ],
  );

  await admin.query(
    `INSERT INTO supply_facts (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
     VALUES ($1, 21500000, $3, 7000000000000, $3),
            ($2, 12000000, $3, 3000000000000, $3)`,
    [SEED_IDS.ethereum, SEED_IDS.base, new Date('2026-03-31T23:50:00.000Z')],
  );

  await admin.query(
    `INSERT INTO fx_rates (as_of, currency, rate_to_usd, source)
     VALUES ($1, 'USD', 100000000, 'ECB')`,
    [asOf],
  );
}
