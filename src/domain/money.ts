/**
 * Exact integer money and ratio arithmetic.
 *
 * Every function here is total and deterministic. No floating point is used
 * anywhere in a value that reaches a report.
 */

/** FX rates are integers scaled by 1e8. */
export const FX_SCALE = 100_000_000n;

/** Basis points denominator. 10_000 bps = 1.0000 = 100%. */
export const BPS_SCALE = 10_000n;

/**
 * Integer division rounding half away from zero.
 *
 * Banker's rounding would be defensible too, but half-up is what accountants
 * expect to see and what a custodian statement will have used.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  // Round half away from zero: bump when the remainder is at least half of d.
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/** Convert a minor-unit amount from `currency` into USD minor units. */
export function convertToUsdMinor(
  amountMinor: bigint,
  rateToUsdScaled: bigint,
): bigint {
  return divRound(amountMinor * rateToUsdScaled, FX_SCALE);
}

/**
 * Convert an unscaled token supply into USD minor units at a 1:1 peg.
 *
 * A 6-decimal token with supply 1_500_000 is 1.5 tokens => 150 cents.
 */
export function supplyToMinor(totalSupply: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`invalid token decimals: ${decimals}`);
  }
  // supply / 10^decimals * 100
  return divRound(totalSupply * 100n, 10n ** BigInt(decimals));
}

/** Express `part` as a share of `whole` in basis points. Returns 0 when whole is 0. */
export function toBps(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number(divRound(part * BPS_SCALE, whole));
}

/**
 * Whole days from `from` to `to`, truncated toward zero and floored at 0.
 *
 * Uses UTC midnight boundaries so a period end never shifts by a day because of
 * the server's timezone.
 */
export function tenorDays(from: Date, to: Date): number {
  const fromUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toUtc = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const days = Math.floor((toUtc - fromUtc) / 86_400_000);
  return days > 0 ? days : 0;
}

/**
 * Format a rational as a fixed-precision decimal string.
 *
 * Returns a string rather than a number so the value survives serialization
 * without any float representation ambiguity.
 */
export function formatRatio(
  numerator: bigint,
  denominator: bigint,
  decimalPlaces: number,
): string {
  if (denominator === 0n) return (0).toFixed(decimalPlaces);

  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = divRound(numerator * scale, denominator);

  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / scale;
  const frac = abs % scale;

  const sign = negative ? '-' : '';
  if (decimalPlaces === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(decimalPlaces, '0')}`;
}

/** Render minor units as a plain decimal string, e.g. 150_25n -> '150.25'. */
export function formatMinor(amountMinor: bigint, decimalPlaces = 2): string {
  return formatRatio(amountMinor, 10n ** BigInt(decimalPlaces), decimalPlaces);
}
