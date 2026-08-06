import { describe, expect, it } from 'vitest';
import { databaseAvailable, testPool, TEST_DATABASE_URL } from './harness.js';
import { createPool } from '../../src/db/pool.js';
import { fromBigInt, toBigInt, toDateParam } from '../../src/db/types.js';

const available = await databaseAvailable();

describe.skipIf(!available)('Postgres type handling', () => {
  it('parses DATE at UTC midnight, not local midnight', async () => {
    const { rows } = await testPool().query<{ d: Date }>(`SELECT '2026-05-15'::date AS d`);
    const value = rows[0]!.d;

    expect(value.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    // The bug this closes: with the driver default this is local midnight, so on
    // a host east of UTC getUTCDate() would return 14 and every tenor would be
    // off by a day.
    expect(value.getUTCDate()).toBe(15);
    expect(value.getUTCMonth()).toBe(4);
    expect(value.getUTCFullYear()).toBe(2026);
  });

  it('round-trips a DATE through a write and read without shifting a day', async () => {
    const original = new Date('2026-05-15T00:00:00.000Z');
    const { rows } = await testPool().query<{ d: Date }>(
      `SELECT $1::date AS d`,
      [toDateParam(original)],
    );
    expect(rows[0]!.d.toISOString()).toBe(original.toISOString());
  });

  it('returns BIGINT as a string so large values keep full precision', async () => {
    const { rows } = await testPool().query<{ big: string }>(
      `SELECT 9223372036854775807::bigint AS big`,
    );
    expect(typeof rows[0]!.big).toBe('string');
    expect(toBigInt(rows[0]!.big)).toBe(9_223_372_036_854_775_807n);
  });

  it('returns NUMERIC(78,0) as a string, preserving a uint256-scale supply', async () => {
    // 10 billion tokens at 18 decimals — ~1e28, far beyond Number.MAX_SAFE_INTEGER.
    const huge = 10_000_000_000n * 10n ** 18n;
    const { rows } = await testPool().query<{ n: string }>(`SELECT $1::numeric(78,0) AS n`, [
      fromBigInt(huge),
    ]);
    expect(toBigInt(rows[0]!.n)).toBe(huge);
  });

  it('stores timestamps at millisecond precision so a hashed value survives reload', async () => {
    const pool = testPool();
    await pool.query(`CREATE TEMP TABLE ts_probe (t TIMESTAMPTZ(3))`);
    const original = new Date('2026-03-31T23:50:00.123Z');
    await pool.query(`INSERT INTO ts_probe (t) VALUES ($1)`, [original]);

    const { rows } = await pool.query<{ t: Date }>(`SELECT t FROM ts_probe`);
    expect(rows[0]!.t.toISOString()).toBe(original.toISOString());
    expect(rows[0]!.t.getTime()).toBe(original.getTime());
    await pool.query(`DROP TABLE ts_probe`);
  });

  it('pins every schema timestamp to millisecond precision', async () => {
    const { rows } = await testPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type = 'timestamp with time zone'
          AND datetime_precision <> 3`,
    );
    expect(rows).toEqual([]);
  });

  it('rejects TIMESTAMP WITHOUT TIME ZONE rather than guessing a zone', async () => {
    await expect(
      testPool().query(`SELECT '2026-03-31 23:50:00'::timestamp AS t`),
    ).rejects.toThrow(/TIMESTAMP WITHOUT TIME ZONE is not permitted/);
  });

  it('runs sessions in UTC', async () => {
    // `SHOW` does not accept a column alias; the column is named TimeZone.
    const { rows } = await testPool().query<{ TimeZone: string }>(`SHOW TIME ZONE`);
    expect(rows[0]!.TimeZone).toBe('UTC');
  });

  it('applies the UTC session zone before the first query, with no race', async () => {
    // A fresh pool: the very first statement on a new connection must already
    // see UTC. This fails if the zone is set from a non-awaited connect handler.
    const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const { rows } = await pool.query<{ TimeZone: string }>(`SHOW TIME ZONE`);
      expect(rows[0]!.TimeZone).toBe('UTC');
    } finally {
      await pool.end();
    }
  });
});

describe('type conversion helpers', () => {
  it('rejects a non-integer string instead of returning NaN', () => {
    expect(() => toBigInt('12.5')).toThrow(TypeError);
    expect(() => toBigInt('abc')).toThrow(TypeError);
  });

  it('rejects NULL for a required numeric column', () => {
    expect(() => toBigInt(null)).toThrow(TypeError);
  });

  it('rejects an unsafe JS number, which would already have lost precision', () => {
    expect(() => toBigInt(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
  });

  it('formats a DATE parameter in UTC', () => {
    expect(toDateParam(new Date('2026-05-15T23:59:59.999Z'))).toBe('2026-05-15');
    expect(toDateParam(null)).toBeNull();
  });
});
