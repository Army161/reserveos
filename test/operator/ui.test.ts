import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  groupDigits,
  percent,
  ratioToPercent,
  shortHash,
  usd,
} from '../../src/operator/ui.mjs';
import { formatMinor } from '../../src/domain/money.js';

/**
 * Formatting for the operator console.
 *
 * The reason this has its own suite: the API sends every amount as a decimal
 * string precisely so it never touches IEEE-754, and the last place that
 * guarantee can be thrown away is on the way to the screen. `Number(x).
 * toLocaleString()` would be shorter than `groupDigits` and would silently round
 * anything above 2^53 — which token supply routinely exceeds.
 */

describe('groupDigits', () => {
  it('groups thousands', () => {
    expect(groupDigits('10500000.00')).toBe('10,500,000.00');
    expect(groupDigits('999.99')).toBe('999.99');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('0.05')).toBe('0.05');
  });

  it('handles the exact boundaries where grouping starts', () => {
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('999999')).toBe('999,999');
    expect(groupDigits('1000000')).toBe('1,000,000');
  });

  it('keeps every digit of a value far beyond Number.MAX_SAFE_INTEGER', () => {
    // 10 billion tokens at 18 decimals, in raw units: ~1e28.
    const raw = (10_000_000_000n * 10n ** 18n).toString();
    const formatted = groupDigits(raw);

    expect(formatted.replace(/,/g, '')).toBe(raw);
    // The proof that no float was involved: this value is not representable.
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('preserves trailing zeros, which carry precision in a money string', () => {
    expect(groupDigits('1000.10')).toBe('1,000.10');
    expect(groupDigits('1000.00')).toBe('1,000.00');
  });

  it('handles negatives', () => {
    expect(groupDigits('-1234567.89')).toBe('-1,234,567.89');
  });

  it('returns a placeholder for absent or non-string input', () => {
    expect(groupDigits('')).toBe('—');
    expect(groupDigits(undefined as unknown as string)).toBe('—');
    expect(groupDigits(null as unknown as string)).toBe('—');
  });
});

describe('usd', () => {
  it('renders a currency amount', () => {
    expect(usd('10500000.00')).toBe('$10,500,000.00');
  });

  it('renders a dash rather than "$null" for a missing value', () => {
    expect(usd(null)).toBe('—');
    expect(usd(undefined)).toBe('—');
  });

  it('round-trips what the domain layer formats', () => {
    // The two ends of the pipeline must agree: bigint cents -> string -> screen.
    expect(usd(formatMinor(1_050_000_000n))).toBe('$10,500,000.00');
    expect(usd(formatMinor(5n))).toBe('$0.05');
  });
});

describe('ratioToPercent', () => {
  it('shifts a 4dp ratio to a 2dp percentage', () => {
    expect(ratioToPercent('1.0500')).toBe('105.00%');
    expect(ratioToPercent('1.0000')).toBe('100.00%');
    expect(ratioToPercent('0.9987')).toBe('99.87%');
  });

  it('handles a ratio far above parity without losing digits', () => {
    expect(ratioToPercent('12.3456')).toBe('1234.56%');
  });

  it('returns a placeholder when the ratio is undefined', () => {
    // Null when nothing is outstanding — dividing by zero is not a number here.
    expect(ratioToPercent(null)).toBe('—');
    expect(ratioToPercent('')).toBe('—');
  });
});

describe('percent', () => {
  it('appends a sign without reformatting the value', () => {
    expect(percent('80.95')).toBe('80.95%');
    expect(percent(null)).toBe('—');
  });
});

describe('shortHash', () => {
  it('abbreviates a digest for display', () => {
    const hash = 'a'.repeat(32) + 'b'.repeat(32);
    expect(shortHash(hash)).toBe('aaaaaaaaaa…bbbbbb');
  });

  it('leaves a short value alone rather than producing a misleading ellipsis', () => {
    expect(shortHash('abc')).toBe('abc');
  });
});

describe('formatDateTime', () => {
  it('renders UTC explicitly, so a period boundary cannot shift by timezone', () => {
    expect(formatDateTime('2026-03-31T23:59:59.999Z')).toBe('2026-03-31 23:59:59 UTC');
  });

  it('converts an offset instead of relabelling it', () => {
    // The bug this pins: slicing the characters out and appending ' UTC' turned
    // this into '23:59:59 UTC' — two hours wrong, and stated with confidence on
    // a screen someone signs from.
    expect(formatDateTime('2026-03-31T23:59:59+02:00')).toBe('2026-03-31 21:59:59 UTC');
    expect(formatDateTime('2026-03-31T23:59:59-05:00')).toBe('2026-04-01 04:59:59 UTC');
  });

  it('rolls the date when an offset crosses midnight', () => {
    expect(formatDateTime('2026-03-31T00:30:00+02:00')).toBe('2026-03-30 22:30:00 UTC');
  });

  it('refuses anything that is not a full instant, rather than labelling it UTC', () => {
    // Each of these previously rendered with a ' UTC' suffix it had not earned.
    for (const value of [
      '2026-03-31', // date only: a day, not an instant
      '2026-03-31T23:59:59', // no zone: a wall clock, not an instant
      'garbage',
      '',
    ]) {
      expect(formatDateTime(value), value).toBe('—');
    }
  });

  it('returns a placeholder for a missing timestamp', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });

  it('accepts every timestamp shape the API actually emits', () => {
    // Everything server-side is `Date.toISOString()`, with and without millis.
    expect(formatDateTime(new Date('2026-04-02T14:30:00.000Z').toISOString())).toBe(
      '2026-04-02 14:30:00 UTC',
    );
    expect(formatDateTime('2026-04-02T14:30:00Z')).toBe('2026-04-02 14:30:00 UTC');
  });
});
