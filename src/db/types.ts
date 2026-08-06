import pg from 'pg';

/**
 * Postgres type-parser configuration.
 *
 * MUST be applied before any pool is created. `configureTypeParsers()` is called
 * from `pool.ts` at module load, so importing the pool is sufficient.
 *
 * These overrides are not stylistic. Each one closes a silent data-corruption
 * path that the driver's defaults leave open.
 */

/** Postgres type OIDs we care about. */
const OID = {
  INT8: 20,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
} as const;

let configured = false;

export function configureTypeParsers(): void {
  if (configured) return;
  configured = true;

  /**
   * DATE: the driver's default builds a Date at *local* midnight.
   *
   * On a host east of UTC, '2026-05-15' becomes 2026-05-14T14:00:00Z, so
   * `getUTCDate()` returns 14. `tenorDays` works in UTC, so every maturity would
   * shift a day and an instrument sitting on the 93-day statutory boundary would
   * flip in or out of breach depending on which region the server runs in.
   *
   * Verified empirically: on a UTC-4 host the default parser yields
   * 2026-05-15T04:00:00.000Z. The bug is invisible west of UTC, which is exactly
   * why it must be closed at the driver rather than caught in review.
   */
  pg.types.setTypeParser(OID.DATE, (value: string) => {
    if (value === null) return null;
    // Postgres emits DATE as 'YYYY-MM-DD'. Anything else means our assumption
    // about the column type is wrong, and guessing would hide the mistake.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError(`unexpected DATE format from Postgres: ${value}`);
    }
    return new Date(`${value}T00:00:00.000Z`);
  });

  /**
   * INT8 and NUMERIC already default to strings, which is what we want: money is
   * `bigint` minor units and token supply is an unscaled uint256, neither of
   * which survives IEEE-754. Re-assert it so a future dependency bump or a
   * well-meaning `pg-types` tweak elsewhere in the process cannot turn these
   * into `number` behind our backs.
   */
  pg.types.setTypeParser(OID.INT8, (value: string) => value);
  pg.types.setTypeParser(OID.NUMERIC, (value: string) => value);

  /**
   * TIMESTAMP WITHOUT TIME ZONE is a foot-gun in a system that hashes ISO
   * strings: the driver interprets it in the server's local zone. We never
   * declare such a column, so treat encountering one as a schema bug.
   */
  pg.types.setTypeParser(OID.TIMESTAMP, (value: string) => {
    throw new TypeError(
      `TIMESTAMP WITHOUT TIME ZONE is not permitted in this schema (got ${value}); ` +
        'use TIMESTAMPTZ',
    );
  });

  // TIMESTAMPTZ keeps the driver default (JS Date). Postgres stores microseconds
  // and the driver truncates to milliseconds, so any value that reaches a hashed
  // payload must be written at millisecond precision. The schema pins the hashed
  // columns to TIMESTAMPTZ(3) and `test/db/roundtrip.test.ts` proves it holds.
}

/**
 * Format a Date as a Postgres DATE literal in UTC.
 *
 * Never pass a JS Date directly to a DATE column: the driver serializes using
 * the host's local zone, which reintroduces the off-by-one day on write that
 * the read parser above closes.
 */
export function toDateParam(date: Date | null): string | null {
  if (date === null) return null;
  return date.toISOString().slice(0, 10);
}

/** Parse a bigint column that the driver handed back as a string. */
export function toBigInt(value: string | number | bigint | null): bigint {
  if (value === null) throw new TypeError('expected a numeric column, got NULL');
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    // Reaching here means a type parser was overridden elsewhere in the process.
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`numeric column arrived as an unsafe JS number: ${value}`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new TypeError(`expected an integer string, got ${value}`);
  }
  return BigInt(value);
}

/** Nullable variant of `toBigInt`. */
export function toBigIntOrNull(value: string | number | bigint | null): bigint | null {
  return value === null ? null : toBigInt(value);
}

/** Serialize a bigint for a BIGINT or NUMERIC parameter. */
export function fromBigInt(value: bigint): string {
  return value.toString();
}
