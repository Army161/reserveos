import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PgCustodianStore,
  PgIssuerStore,
  PgTokenDeploymentStore,
} from '../../src/db/stores/reference.js';
import { PgReportStore } from '../../src/db/stores/reports.js';
import { SEED_IDS, databaseAvailable, resetDatabase, seedTenant, testPool } from './harness.js';

const available = await databaseAvailable();

const ABSENT_ID = '00000000-0000-0000-0000-0000000000ff';
const GENERATOR_ID = '44444444-4444-4444-4444-444444444444';

/**
 * A real SHA-256 digest of the label: 64 lowercase hex characters, exactly what
 * `canonicalHash()` produces in production.
 *
 * Fixtures must be the genuine shape, not merely 64 characters wide. `payload_hash`
 * is CHAR(64) and blank-pads anything shorter without complaint, so a fixture that
 * papered over the width would have hidden the fact that the store used to accept
 * a malformed hash and silently store a different string than the caller signed.
 */
function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function utcDay(iso: string): Date {
  return new Date(iso);
}

/**
 * The seeded rows are inserted in ascending id order, so a sequential scan
 * returns them already sorted and every ordering assertion passes with no
 * ORDER BY at all — verified: deleting both ORDER BY clauses from the store left
 * all tests green. The rows below sort *before* the seeded ones but are inserted
 * *after* them, so physical order and required order genuinely disagree.
 *
 * This is not cosmetic. Custodians and deployments are rendered into the report
 * payload, and the payload hash is what gets signed and anchored; a listing that
 * came back in scan order would produce a different hash on every regeneration
 * and break the determinism test that is the regression net for the product.
 */
const EARLY_ISSUER_ID = '00000000-0000-0000-0000-0000000000a1';
const EARLY_CUSTODIAN_ID = '22222222-2222-2222-2222-222222222220';
const EARLY_DEPLOYMENT_ID = '33333333-3333-3333-3333-333333333330';

async function insertLowSortingIssuer(): Promise<void> {
  await testPool().query(
    `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
     VALUES ($1, 'Aardvark Trust Co.', 'OCC', 'env-early')`,
    [EARLY_ISSUER_ID],
  );
}

async function insertLowSortingCustodian(): Promise<void> {
  await testPool().query(
    `INSERT INTO custodians (id, issuer_id, name, jurisdiction, connector_type)
     VALUES ($1, $2, 'Zurich Vault', 'CH', 'manual')`,
    [EARLY_CUSTODIAN_ID, SEED_IDS.issuerId],
  );
}

async function insertLowSortingDeployment(): Promise<void> {
  await testPool().query(
    `INSERT INTO token_deployments
       (id, issuer_id, chain_id, contract_address, symbol, decimals, kaleido_connector_id)
     VALUES ($1, $2, 1, '0x1111000000000000000000000000000000000003', 'ACME', 6, 'conn-early')`,
    [EARLY_DEPLOYMENT_ID, SEED_IDS.issuerId],
  );
}

describe.skipIf(!available)('reference and reporting stores', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  describe('PgIssuerStore', () => {
    it('maps every column of the seeded issuer', async () => {
      const store = new PgIssuerStore(testPool());

      const issuer = await store.get(SEED_IDS.issuerId);

      expect(issuer).toEqual({
        id: SEED_IDS.issuerId,
        legalName: 'Acme Digital Trust Company, N.A.',
        regulator: 'OCC',
        kaleidoEnvId: 'env-test',
        anchorContractAddress: null,
        businessCalendar: 'US_FEDERAL',
        ruleConfig: {},
      });
    });

    it('returns null for an unknown id and lists all issuers', async () => {
      const store = new PgIssuerStore(testPool());

      expect(await store.get(ABSENT_ID)).toBeNull();
      expect((await store.listAll()).map((i) => i.id)).toEqual([SEED_IDS.issuerId]);
    });

    it('lists issuers by id regardless of insertion order', async () => {
      await insertLowSortingIssuer();

      const store = new PgIssuerStore(testPool());

      expect((await store.listAll()).map((i) => i.id)).toEqual([EARLY_ISSUER_ID, SEED_IDS.issuerId]);
    });

    it('round-trips a nested rule_config as an object', async () => {
      const ruleConfig = {
        maxTenorDays: 93,
        custodianConcentrationBps: 3500,
        ineligible: ['REPO', 'OTHER'],
        buffer: { warningBps: 10_050, criticalBps: 10_000 },
      };
      await testPool().query('UPDATE issuers SET rule_config = $2::JSONB WHERE id = $1', [
        SEED_IDS.issuerId,
        JSON.stringify(ruleConfig),
      ]);

      const issuer = await new PgIssuerStore(testPool()).get(SEED_IDS.issuerId);

      expect(issuer?.ruleConfig).toEqual(ruleConfig);
    });

    it('throws rather than defaulting when rule_config is not an object', async () => {
      await testPool().query("UPDATE issuers SET rule_config = 'null'::JSONB WHERE id = $1", [
        SEED_IDS.issuerId,
      ]);

      await expect(new PgIssuerStore(testPool()).get(SEED_IDS.issuerId)).rejects.toThrow(
        /rule_config is not a JSON object/,
      );
    });
  });

  describe('PgCustodianStore', () => {
    it('lists custodians for an issuer ordered by id with connector wiring', async () => {
      const store = new PgCustodianStore(testPool());

      const custodians = await store.listForIssuer(SEED_IDS.issuerId);

      expect(custodians.map((c) => c.id)).toEqual([
        SEED_IDS.bny,
        SEED_IDS.stateStreet,
        SEED_IDS.euroclear,
      ]);
      expect(custodians.map((c) => c.name)).toEqual(['BNY Mellon', 'State Street', 'Euroclear']);
      expect(custodians.map((c) => c.jurisdiction)).toEqual(['US', 'US', 'BE']);
      expect(custodians.map((c) => c.connectorType)).toEqual(['sftp_csv', 'sftp_csv', 'api_rest']);
      expect(custodians.every((c) => c.issuerId === SEED_IDS.issuerId)).toBe(true);
      expect(custodians.every((c) => c.active)).toBe(true);
    });

    it('excludes inactive custodians from the active listing only', async () => {
      await testPool().query('UPDATE custodians SET active = FALSE WHERE id = $1', [
        SEED_IDS.euroclear,
      ]);
      const store = new PgCustodianStore(testPool());

      expect((await store.listActiveForIssuer(SEED_IDS.issuerId)).map((c) => c.id)).toEqual([
        SEED_IDS.bny,
        SEED_IDS.stateStreet,
      ]);
      expect(await store.listForIssuer(SEED_IDS.issuerId)).toHaveLength(3);
      expect((await store.get(SEED_IDS.euroclear))?.active).toBe(false);
    });

    it('round-trips connector_config as an object', async () => {
      const config = {
        host: 'sftp.bny.example',
        port: 22,
        credentialRef: 'vault://reserveos/custodians/bny',
        paths: ['/outbound/positions', '/outbound/valuations'],
        retry: { attempts: 3, backoffMs: 2_000 },
      };
      await testPool().query('UPDATE custodians SET connector_config = $2::JSONB WHERE id = $1', [
        SEED_IDS.bny,
        JSON.stringify(config),
      ]);

      const custodian = await new PgCustodianStore(testPool()).get(SEED_IDS.bny);

      expect(custodian?.connectorConfig).toEqual(config);
      expect(Array.isArray(custodian?.connectorConfig['paths'])).toBe(true);
    });

    it('returns null for an unknown custodian', async () => {
      expect(await new PgCustodianStore(testPool()).get(ABSENT_ID)).toBeNull();
    });

    it('orders custodians by id regardless of physical row order', async () => {
      await insertLowSortingCustodian();
      const store = new PgCustodianStore(testPool());

      expect((await store.listForIssuer(SEED_IDS.issuerId)).map((c) => c.id)).toEqual([
        EARLY_CUSTODIAN_ID,
        SEED_IDS.bny,
        SEED_IDS.stateStreet,
        SEED_IDS.euroclear,
      ]);
      expect((await store.listActiveForIssuer(SEED_IDS.issuerId)).map((c) => c.id)).toEqual([
        EARLY_CUSTODIAN_ID,
        SEED_IDS.bny,
        SEED_IDS.stateStreet,
        SEED_IDS.euroclear,
      ]);
    });
  });

  describe('PgTokenDeploymentStore', () => {
    it('lists deployments ordered by chain then address', async () => {
      const store = new PgTokenDeploymentStore(testPool());

      const deployments = await store.listForIssuer(SEED_IDS.issuerId);

      expect(deployments).toEqual([
        {
          id: SEED_IDS.ethereum,
          issuerId: SEED_IDS.issuerId,
          chainId: 1,
          contractAddress: '0xaaaa000000000000000000000000000000000001',
          symbol: 'ACME',
          decimals: 6,
          active: true,
        },
        {
          id: SEED_IDS.base,
          issuerId: SEED_IDS.issuerId,
          chainId: 8453,
          contractAddress: '0xbbbb000000000000000000000000000000000002',
          symbol: 'ACME',
          decimals: 6,
          active: true,
        },
      ]);
    });

    it('excludes inactive deployments from the active listing only', async () => {
      await testPool().query('UPDATE token_deployments SET active = FALSE WHERE id = $1', [
        SEED_IDS.base,
      ]);
      const store = new PgTokenDeploymentStore(testPool());

      expect((await store.listActiveForIssuer(SEED_IDS.issuerId)).map((d) => d.id)).toEqual([
        SEED_IDS.ethereum,
      ]);
      expect(await store.listForIssuer(SEED_IDS.issuerId)).toHaveLength(2);
      expect((await store.get(SEED_IDS.base))?.active).toBe(false);
      expect(await store.get(ABSENT_ID)).toBeNull();
    });

    it('orders deployments by chain then address regardless of physical row order', async () => {
      // Same chain as the seeded Ethereum row but a lower address, inserted last:
      // this pins the secondary sort key as well as the primary one.
      await insertLowSortingDeployment();
      const store = new PgTokenDeploymentStore(testPool());

      expect((await store.listForIssuer(SEED_IDS.issuerId)).map((d) => d.contractAddress)).toEqual([
        '0x1111000000000000000000000000000000000003',
        '0xaaaa000000000000000000000000000000000001',
        '0xbbbb000000000000000000000000000000000002',
      ]);
    });
  });

  describe('PgReportStore periods', () => {
    it('is idempotent on a repeated openPeriod', async () => {
      const store = new PgReportStore(testPool());
      const start = utcDay('2026-06-01T00:00:00.000Z');
      const end = utcDay('2026-06-30T00:00:00.000Z');

      const first = await store.openPeriod(SEED_IDS.issuerId, start, end);
      const second = await store.openPeriod(SEED_IDS.issuerId, start, end);

      expect(second.id).toBe(first.id);
      expect(second).toEqual(first);
      const { rows } = await testPool().query('SELECT count(*)::INT AS n FROM reporting_periods');
      expect(rows[0].n).toBe(1);
    });

    /**
     * Passing a raw Date to a DATE column serializes it in the *host's* zone, so
     * the resulting off-by-one day depends on which side of UTC the host sits:
     * a time late in the UTC day rolls forward east of UTC, and a time at UTC
     * midnight rolls back west of UTC. Covering only one of those makes the test
     * vacuous on half the world's machines — verified: dropping `toDateParam`
     * from `period_end` alone left the single-case version of this test green on
     * a UTC-4 host. Both columns are therefore exercised in both directions.
     */
    it('round-trips period DATE columns to the correct UTC calendar day', async () => {
      const store = new PgReportStore(testPool());

      async function storedDays(id: string): Promise<{ start: string; end: string }> {
        const { rows } = await testPool().query(
          `SELECT to_char(period_start, $2) AS s, to_char(period_end, $2) AS e
             FROM reporting_periods WHERE id = $1`,
          [id, 'YYYY-MM-DD'],
        );
        return { start: rows[0].s, end: rows[0].e };
      }

      // End late in the UTC day: rolls forward to April 1st east of UTC.
      const lateEnd = await store.openPeriod(
        SEED_IDS.issuerId,
        utcDay('2026-03-01T00:00:00.000Z'),
        utcDay('2026-03-31T23:30:00.000Z'),
      );
      expect(lateEnd.periodStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
      expect(lateEnd.periodEnd.toISOString()).toBe('2026-03-31T00:00:00.000Z');
      expect(lateEnd.periodEnd.getUTCDate()).toBe(31);
      expect(await storedDays(lateEnd.id)).toEqual({ start: '2026-03-01', end: '2026-03-31' });

      // End at UTC midnight: rolls back to April 29th west of UTC.
      const midnightEnd = await store.openPeriod(
        SEED_IDS.issuerId,
        utcDay('2026-04-01T00:00:00.000Z'),
        utcDay('2026-04-30T00:00:00.000Z'),
      );
      expect(midnightEnd.periodEnd.toISOString()).toBe('2026-04-30T00:00:00.000Z');
      expect(await storedDays(midnightEnd.id)).toEqual({ start: '2026-04-01', end: '2026-04-30' });

      const reloaded = await store.getPeriod(lateEnd.id);
      expect(reloaded?.periodEnd.toISOString()).toBe('2026-03-31T00:00:00.000Z');
      expect(reloaded?.periodStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('finds a period by issuer and end date, and advances its status', async () => {
      const store = new PgReportStore(testPool());
      const end = utcDay('2026-09-30T00:00:00.000Z');
      const period = await store.openPeriod(SEED_IDS.issuerId, utcDay('2026-09-01T00:00:00.000Z'), end);

      expect(period.status).toBe('OPEN');
      expect((await store.findPeriod(SEED_IDS.issuerId, end))?.id).toBe(period.id);
      expect(await store.findPeriod(SEED_IDS.issuerId, utcDay('2026-10-31T00:00:00.000Z'))).toBeNull();
      expect(await store.getPeriod(ABSENT_ID)).toBeNull();

      await store.setPeriodStatus(period.id, 'CERTIFIED');
      expect((await store.getPeriod(period.id))?.status).toBe('CERTIFIED');

      await expect(store.setPeriodStatus(ABSENT_ID, 'PUBLISHED')).rejects.toThrow(/does not exist/);
    });

    it('refuses to alias a different start onto an existing period end', async () => {
      const store = new PgReportStore(testPool());
      const end = utcDay('2026-11-30T00:00:00.000Z');
      await store.openPeriod(SEED_IDS.issuerId, utcDay('2026-11-01T00:00:00.000Z'), end);

      // The unique key is (issuer_id, period_end), so without a check this would
      // silently hand back the 11-01 window and the caller would file a report
      // for a statutory period it never asked for.
      await expect(
        store.openPeriod(SEED_IDS.issuerId, utcDay('2026-11-15T00:00:00.000Z'), end),
      ).rejects.toThrow(/already exists starting 2026-11-01, not 2026-11-15/);

      const { rows } = await testPool().query('SELECT count(*)::INT AS n FROM reporting_periods');
      expect(rows[0].n).toBe(1);
    });
  });

  describe('PgReportStore versions', () => {
    async function openPeriod(store: PgReportStore, month: string): Promise<string> {
      const period = await store.openPeriod(
        SEED_IDS.issuerId,
        utcDay(`2026-${month}-01T00:00:00.000Z`),
        utcDay(`2026-${month}-28T00:00:00.000Z`),
      );
      return period.id;
    }

    function version(periodId: string, label: string) {
      return {
        periodId,
        payload: { label },
        payloadHash: hash(label),
        generatedAt: new Date('2026-07-01T12:00:00.000Z'),
        generatedBy: GENERATOR_ID,
      };
    }

    it('numbers versions from 1 per period', async () => {
      const store = new PgReportStore(testPool());
      const january = await openPeriod(store, '01');
      const february = await openPeriod(store, '02');

      const a = await store.insertVersion(version(january, 'jan-a'));
      const b = await store.insertVersion(version(january, 'jan-b'));
      const c = await store.insertVersion(version(january, 'jan-c'));
      const d = await store.insertVersion(version(february, 'feb-a'));

      expect([a.version, b.version, c.version]).toEqual([1, 2, 3]);
      expect(d.version).toBe(1);
      expect((await store.listVersions(january)).map((v) => v.version)).toEqual([1, 2, 3]);
      expect((await store.listVersions(february)).map((v) => v.version)).toEqual([1]);
      expect((await store.getLatestVersion(january))?.id).toBe(c.id);
      expect((await store.getLatestVersion(february))?.id).toBe(d.id);
      expect(await store.getLatestVersion(ABSENT_ID)).toBeNull();
    });

    it('allocates 1..8 with no duplicates under concurrent inserts', async () => {
      const store = new PgReportStore(testPool());
      const periodId = await openPeriod(store, '04');

      const inserted = await Promise.all(
        Array.from({ length: 8 }, (_unused, i) => store.insertVersion(version(periodId, `c${i}`))),
      );

      const numbers = inserted.map((v) => v.version).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(inserted.map((v) => v.id)).size).toBe(8);
      expect((await store.listVersions(periodId)).map((v) => v.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('round-trips a deeply nested payload unchanged', async () => {
      const store = new PgReportStore(testPool());
      const periodId = await openPeriod(store, '05');
      const payload = {
        asOf: '2026-05-31T23:59:59.999Z',
        // Money crosses JSON as a decimal string: a JS number would silently lose
        // precision on a uint256 supply figure.
        totals: {
          reserveValueMinor: '123456789012345678901234567890',
          outstandingMinor: '98765432109876543210',
          collateralizationRatioBps: 10_042,
        },
        categories: [
          {
            category: 'TBILL',
            marketValueMinor: '5000000000',
            custody: [{ jurisdiction: 'US', valueMinor: '5000000000' }],
          },
          { category: 'CASH', marketValueMinor: '0', custody: [] },
        ],
        breaches: [],
        lineage: { factIds: ['a', 'b', 'c'], missing: null, nested: { deep: { ok: true } } },
      };

      const written = await store.insertVersion({
        periodId,
        payload,
        payloadHash: hash('deep'),
        generatedAt: new Date('2026-06-01T09:15:30.250Z'),
        generatedBy: GENERATOR_ID,
      });

      expect(written.payload).toEqual(payload);
      const reloaded = await store.getLatestVersion(periodId);
      expect(reloaded?.payload).toEqual(payload);
      expect(reloaded?.generatedAt.toISOString()).toBe('2026-06-01T09:15:30.250Z');
      expect(reloaded?.generatedBy).toBe(GENERATOR_ID);
    });

    it('rejects a duplicate payload hash', async () => {
      const store = new PgReportStore(testPool());
      const first = await openPeriod(store, '06');
      const second = await openPeriod(store, '07');
      await store.insertVersion({ ...version(first, 'shared'), payload: { n: 1 } });

      await expect(
        store.insertVersion({ ...version(second, 'shared'), payload: { n: 2 } }),
      ).rejects.toThrow(/payload_hash/);
    });

    /**
     * `payload_hash` is CHAR(64). Postgres blank-pads a shorter value silently,
     * so the string read back is no longer the string the caller hashed and
     * signed — and `certification.ts` hands exactly this value to the anchor
     * store as the merkle root, where a padded 64-character value passes the
     * length check and gets committed to the chain. Verification of that report
     * would then fail forever, indistinguishably from tampering.
     */
    it('rejects a payload hash that is not 64 lowercase hex characters', async () => {
      const store = new PgReportStore(testPool());
      const periodId = await openPeriod(store, '09');

      for (const bad of [
        'deadbeef', // short: would be blank-padded to a different string
        `${hash('x')}0`, // long
        hash('x').toUpperCase(), // wrong case: a different string to a hex comparer
        `${hash('x').slice(0, 63)}z`, // not hex
        `${hash('x').slice(0, 60)}    `, // already padded
      ]) {
        await expect(
          store.insertVersion({
            periodId,
            payload: { n: 1 },
            payloadHash: bad,
            generatedAt: new Date('2026-07-01T12:00:00.000Z'),
            generatedBy: GENERATOR_ID,
          }),
        ).rejects.toThrow(/64 lowercase hex/);
      }

      // Nothing was written, and a valid hash still works afterwards.
      expect(await store.listVersions(periodId)).toEqual([]);
      const ok = await store.insertVersion(version(periodId, 'valid'));
      expect(ok.payloadHash).toBe(hash('valid'));
      expect(ok.payloadHash).toHaveLength(64);
    });

    it('cannot store a malformed payload hash, at either layer', async () => {
      const store = new PgReportStore(testPool());
      const periodId = await openPeriod(store, '10');

      // Layer 1 — the database. `payload_hash` was CHAR(64), which blank-pads,
      // and bpchar comparison ignores trailing blanks, so findByHash still
      // matched the corrupted row and hid the damage. Migration 003 made the
      // column TEXT with a format CHECK.
      await expect(
        testPool().query(
          `INSERT INTO report_versions
             (period_id, version, payload, payload_hash, generated_at, generated_by)
           VALUES ($1, 1, '{}'::JSONB, $2, now(), $3)`,
          [periodId, 'deadbeef', GENERATOR_ID],
        ),
      ).rejects.toThrow(/report_versions_payload_hash_format/);

      // Layer 2 — the store rejects it before it reaches the database.
      await expect(
        store.insertVersion({
          periodId,
          payload: {},
          payloadHash: 'deadbeef',
          generatedAt: new Date('2026-04-02T14:30:00.000Z'),
          generatedBy: GENERATOR_ID,
        }),
      ).rejects.toThrow(/64 lowercase hex/);
    });

    it('locates a version by payload hash', async () => {
      const store = new PgReportStore(testPool());
      const periodId = await openPeriod(store, '08');
      await store.insertVersion(version(periodId, 'other'));
      const target = await store.insertVersion(version(periodId, 'examiner'));

      const found = await store.findByHash(hash('examiner'));

      expect(found?.id).toBe(target.id);
      expect(found?.version).toBe(2);
      expect(found?.periodId).toBe(periodId);
      expect(await store.findByHash(hash('never-generated'))).toBeNull();
    });
  });
});
