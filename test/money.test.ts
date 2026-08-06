import { describe, expect, it } from 'vitest';
import {
  convertToUsdMinor,
  divRound,
  formatMinor,
  formatRatio,
  supplyToMinor,
  tenorDays,
  toBps,
  FX_SCALE,
} from '../src/domain/money.js';

describe('divRound', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
  });

  it('rejects division by zero rather than returning a silent value', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('supplyToMinor', () => {
  it('converts a 6-decimal supply to cents', () => {
    // 1.5 tokens -> 150 cents
    expect(supplyToMinor(1_500_000n, 6)).toBe(150n);
  });

  it('converts an 18-decimal supply without precision loss', () => {
    const oneMillionTokens = 1_000_000n * 10n ** 18n;
    expect(supplyToMinor(oneMillionTokens, 18)).toBe(100_000_000n);
  });

  it('handles a supply far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    // 10 billion tokens at 18 decimals is ~1e28, unrepresentable as a JS number.
    const huge = 10_000_000_000n * 10n ** 18n;
    expect(supplyToMinor(huge, 18)).toBe(1_000_000_000_000n);
  });

  it('rejects nonsense decimals', () => {
    expect(() => supplyToMinor(1n, -1)).toThrow(RangeError);
    expect(() => supplyToMinor(1n, 1.5)).toThrow(RangeError);
  });
});

describe('convertToUsdMinor', () => {
  it('is an identity at a unit rate', () => {
    expect(convertToUsdMinor(123_456n, FX_SCALE)).toBe(123_456n);
  });

  it('applies a fractional rate with rounding', () => {
    // 100.00 EUR at 1.0852 -> 108.52 USD
    expect(convertToUsdMinor(10_000n, 108_520_000n)).toBe(10_852n);
  });
});

describe('tenorDays', () => {
  it('measures whole days forward', () => {
    expect(tenorDays(new Date('2026-03-31T20:00:00Z'), new Date('2026-06-20T00:00:00Z'))).toBe(81);
  });

  it('floors past maturities at zero rather than going negative', () => {
    expect(tenorDays(new Date('2026-03-31T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });

  it('ignores time-of-day so a period end never shifts by a day', () => {
    const early = tenorDays(new Date('2026-03-31T00:00:01Z'), new Date('2026-04-30T23:59:59Z'));
    const late = tenorDays(new Date('2026-03-31T23:59:59Z'), new Date('2026-04-30T00:00:01Z'));
    expect(early).toBe(30);
    expect(late).toBe(30);
  });

  it('crosses a leap day correctly', () => {
    expect(tenorDays(new Date('2028-02-28T00:00:00Z'), new Date('2028-03-01T00:00:00Z'))).toBe(2);
  });
});

describe('formatRatio / formatMinor', () => {
  it('pads fractional digits', () => {
    expect(formatRatio(1n, 8n, 4)).toBe('0.1250');
    expect(formatMinor(150n)).toBe('1.50');
    expect(formatMinor(5n)).toBe('0.05');
  });

  it('formats large amounts without exponent notation', () => {
    // 105,000,000,000 cents = $1.05bn
    expect(formatMinor(105_000_000_000n)).toBe('1050000000.00');
  });

  it('handles negatives', () => {
    expect(formatMinor(-125n)).toBe('-1.25');
  });
});

describe('toBps', () => {
  it('returns zero for a zero denominator instead of throwing', () => {
    expect(toBps(5n, 0n)).toBe(0);
  });

  it('computes a share in basis points', () => {
    expect(toBps(1n, 2n)).toBe(5_000);
    expect(toBps(1n, 3n)).toBe(3_333);
  });
});
