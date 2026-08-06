import { describe, expect, it } from 'vitest';

import {
  mapStatementLine,
  parseAmountToMinor,
  parseCategory,
  parseCusip,
  parseStatementDate,
  ValueParseError,
  type DateFormat,
  type StatementMapping,
} from '../../src/ingest/mapping.js';

/** Assert the call throws a `ValueParseError` and hand the error back for inspection. */
function expectParseError(fn: () => unknown): ValueParseError {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValueParseError);
  return caught as ValueParseError;
}

describe('parseAmountToMinor', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, bigint]> = [
    ['1,234,567.89', 123_456_789n],
    ['1234.5', 123_450n],
    ['(500.00)', -50_000n],
    ['$1,000', 100_000n],
    ['0', 0n],
    ['0.00', 0n],
    ['0.0', 0n],
    ['(0.00)', 0n],
    ['$0.01', 1n],
    ['  42  ', 4_200n],
    ['999', 99_900n],
    ['100.1', 10_010n],
    ['1,000,000', 100_000_000n],
    ['1,000,000.00', 100_000_000n],
    ['-1.23', -123n],
    ['-$1,000.50', -100_050n],
    ['$-1,000.50', -100_050n],
    ['( 1,234.56 )', -123_456n],
    ['($1,234.56)', -123_456n],
    ['$ 1,234.56', 123_456n],
    ['-  0.05', -5n],
    ['123', 12_300n],
  ];

  for (const [raw, expected] of ACCEPTED) {
    it(`parses ${JSON.stringify(raw)} as ${expected}`, () => {
      expect(parseAmountToMinor(raw)).toBe(expected);
    });
  }

  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['abc', 'non-numeric junk'],
    ['1.2.3', 'multiple decimal points'],
    ['1,234.5.6', 'multiple decimal points after grouping'],
    ['-', 'bare minus'],
    ['$', 'bare currency symbol'],
    ['()', 'empty parentheses'],
    ['(-1.00)', 'minus inside parentheses'],
    ['-(1.00)', 'minus outside parentheses'],
    ['(500.00', 'unclosed parenthesis'],
    ['500.00)', 'unopened parenthesis'],
    ['1.234', 'three decimal places'],
    ['1.0000', 'four decimal places'],
    ['0.001', 'sub-cent precision'],
    ['1,23,456', 'misplaced thousands separator'],
    ['12,34', 'short trailing group'],
    ['1234,567', 'oversized lead group'],
    ['1,234,56', 'short final group'],
    [',123', 'leading separator'],
    ['1,', 'trailing separator'],
    ['1.', 'trailing decimal point'],
    ['.50', 'no digits before the decimal point'],
    ['1 234.56', 'space as a thousands separator'],
    ['--100', 'double minus'],
    ['+100', 'leading plus'],
    ['100-', 'trailing minus'],
    ['$$100', 'double currency symbol'],
    ['1.2e3', 'scientific notation'],
    ['1,234.5x', 'trailing junk'],
    ['NULL', 'null placeholder'],
    ['N/A', 'not-available placeholder'],
  ];

  for (const [raw, why] of REJECTED) {
    it(`rejects ${JSON.stringify(raw)} (${why})`, () => {
      expectParseError(() => parseAmountToMinor(raw));
    });
  }

  it('is exact for a fourteen-digit amount', () => {
    expect(parseAmountToMinor('12345678901234.56')).toBe(1_234_567_890_123_456n);
    expect(parseAmountToMinor('$12,345,678,901,234.56')).toBe(1_234_567_890_123_456n);
  });

  it('keeps digits that a float round-trip would lose', () => {
    // Number('99999999999999.99') * 100 is 9999999999999998 — two cents short,
    // and the result is silently plausible. This is why the parser never goes
    // through Number/parseFloat.
    expect(parseAmountToMinor('$99,999,999,999,999.99')).toBe(9_999_999_999_999_999n);
    expect(Number('99999999999999.99') * 100).not.toBe(9_999_999_999_999_999);

    // The same hazard at everyday magnitudes: 1.15 * 100 is 114.99999999999999,
    // which truncates to 114.
    expect(parseAmountToMinor('1.15')).toBe(115n);
    expect(Math.trunc(Number('1.15') * 100)).toBe(114);
  });

  it('carries the field name and raw text on the error', () => {
    const error = expectParseError(() => parseAmountToMinor('12.345', 'marketValue'));
    expect(error.field).toBe('marketValue');
    expect(error.raw).toBe('12.345');
    expect(error.message).toContain('marketValue');
  });

  it('defaults the field name when none is supplied', () => {
    expect(expectParseError(() => parseAmountToMinor('junk')).field).toBe('amount');
  });
});

describe('parseStatementDate', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, DateFormat, string]> = [
    ['2026-01-15', 'ISO', '2026-01-15T00:00:00.000Z'],
    ['2026/01/15', 'ISO', '2026-01-15T00:00:00.000Z'],
    ['2026-1-5', 'ISO', '2026-01-05T00:00:00.000Z'],
    ['  2026-01-15  ', 'ISO', '2026-01-15T00:00:00.000Z'],
    ['01/15/2026', 'US', '2026-01-15T00:00:00.000Z'],
    ['1-15-2026', 'US', '2026-01-15T00:00:00.000Z'],
    ['12/31/2026', 'US', '2026-12-31T00:00:00.000Z'],
    ['15/01/2026', 'EU', '2026-01-15T00:00:00.000Z'],
    ['15-01-2026', 'EU', '2026-01-15T00:00:00.000Z'],
    ['31/12/2026', 'EU', '2026-12-31T00:00:00.000Z'],
    // 2028 is a leap year, 2000 is one too (divisible by 400).
    ['2028-02-29', 'ISO', '2028-02-29T00:00:00.000Z'],
    ['02/29/2028', 'US', '2028-02-29T00:00:00.000Z'],
    ['29/02/2028', 'EU', '2028-02-29T00:00:00.000Z'],
    ['2000-02-29', 'ISO', '2000-02-29T00:00:00.000Z'],
  ];

  for (const [raw, format, expected] of ACCEPTED) {
    it(`parses ${JSON.stringify(raw)} as ${format} -> ${expected}`, () => {
      expect(parseStatementDate(raw, format).toISOString()).toBe(expected);
    });
  }

  it('returns UTC midnight, not local midnight', () => {
    const date = parseStatementDate('2026-06-30', 'ISO');
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCMinutes()).toBe(0);
    expect(date.getUTCSeconds()).toBe(0);
    expect(date.getUTCMilliseconds()).toBe(0);
    expect(date.getTime()).toBe(Date.UTC(2026, 5, 30));
  });

  it('reads the same text differently under US and EU, which is why the format is configured', () => {
    // 03/04/2026 is 4 March under MM/DD/YYYY and 3 April under DD/MM/YYYY.
    // Inferring the format from the value is impossible; it must come from the
    // custodian's configuration.
    const us = parseStatementDate('03/04/2026', 'US');
    const eu = parseStatementDate('03/04/2026', 'EU');
    expect(us.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(eu.toISOString()).toBe('2026-04-03T00:00:00.000Z');
    expect(us.getTime()).not.toBe(eu.getTime());
  });

  const REJECTED: ReadonlyArray<readonly [string, DateFormat, string]> = [
    ['', 'ISO', 'empty string'],
    ['   ', 'ISO', 'whitespace only'],
    ['not a date', 'ISO', 'junk'],
    ['2026-02-30', 'ISO', 'February never has 30 days'],
    ['2026-13-01', 'ISO', 'month 13'],
    ['2026-00-10', 'ISO', 'month 0'],
    ['2026-01-00', 'ISO', 'day 0'],
    ['2026-01-32', 'ISO', 'day 32'],
    ['2027-02-29', 'ISO', '2027 is not a leap year'],
    ['2026-02-29', 'ISO', '2026 is not a leap year'],
    ['1900-02-29', 'ISO', '1900 is a century non-leap year'],
    ['2026-04-31', 'ISO', 'April has 30 days'],
    ['2026-01/15', 'ISO', 'mixed separators'],
    ['2026.01.15', 'ISO', 'unsupported separator'],
    ['20260115', 'ISO', 'no separators'],
    ['0026-01-01', 'ISO', 'two-digit year would silently remap to 1926'],
    ['15/01/2026', 'ISO', 'US/EU layout under the ISO format'],
    ['2026-01-15', 'US', 'ISO layout under the US format'],
    ['2026-01-15', 'EU', 'ISO layout under the EU format'],
    ['01/15/26', 'US', 'two-digit year is ambiguous'],
    ['13/04/2026', 'US', 'month 13 — US must not silently swap to EU'],
    ['04/31/2026', 'US', 'April has 30 days'],
    ['31/04/2026', 'EU', 'April has 30 days'],
    ['04/13/2026', 'EU', 'month 13 — EU must not silently swap to US'],
    ['01/15/2026 00:00', 'US', 'trailing time component'],
    ['2026-01-15T00:00:00Z', 'ISO', 'timestamp, not a date'],
  ];

  for (const [raw, format, why] of REJECTED) {
    it(`rejects ${JSON.stringify(raw)} as ${format} (${why})`, () => {
      expectParseError(() => parseStatementDate(raw, format));
    });
  }

  it('carries the field name and raw text on the error', () => {
    const error = expectParseError(() => parseStatementDate('2026-02-30', 'ISO', 'maturityDate'));
    expect(error.field).toBe('maturityDate');
    expect(error.raw).toBe('2026-02-30');
  });
});

describe('parseCategory', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['cash', 'CASH'],
    ['Cash', 'CASH'],
    ['  CASH  ', 'CASH'],
    ['deposit', 'CASH'],
    ['Demand Deposit', 'CASH'],
    ['demand deposits', 'CASH'],
    ['Bank Deposit', 'CASH'],
    ['federal reserve', 'FED_DEPOSIT'],
    ['Federal Reserve Deposit', 'FED_DEPOSIT'],
    ['fed deposit', 'FED_DEPOSIT'],
    ['FED_DEPOSIT', 'FED_DEPOSIT'],
    ['Reserve Balance', 'FED_DEPOSIT'],
    ['reserve balances', 'FED_DEPOSIT'],
    ['treasury bill', 'TBILL'],
    ['Treasury Bills', 'TBILL'],
    ['t-bill', 'TBILL'],
    ['T-Bill', 'TBILL'],
    ['tbill', 'TBILL'],
    ['T BILL', 'TBILL'],
    ['US Treasury', 'TBILL'],
    ['u.s. treasury', 'TBILL'],
    ['Bill', 'TBILL'],
    ['money market', 'MMF'],
    ['Money Market Fund', 'MMF'],
    ['mmf', 'MMF'],
    ['MMF', 'MMF'],
    ['Government Money Market Fund', 'MMF'],
    ['repo', 'REPO'],
    ['REPO', 'REPO'],
    ['Repurchase Agreement', 'REPO'],
    ['reverse repo', 'REPO'],
    ['Reverse Repurchase Agreement', 'REPO'],
  ];

  for (const [raw, expected] of ACCEPTED) {
    it(`maps ${JSON.stringify(raw)} to ${expected}`, () => {
      expect(parseCategory(raw)).toBe(expected);
    });
  }

  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['???', 'punctuation only'],
    ['Other', 'an explicit "other" label still needs a human decision'],
    ['OTHER', 'never inferred, even when it matches the enum name'],
    ['Corporate Bond', 'ineligible instrument, must not be silently bucketed'],
    ['Gold', 'unknown instrument'],
    ['Commercial Paper', 'unknown instrument'],
    ['Equity', 'unknown instrument'],
    ['CASHX', 'near-miss of a known wording'],
    ['tbil', 'typo of a known wording'],
  ];

  for (const [raw, why] of REJECTED) {
    it(`rejects ${JSON.stringify(raw)} (${why})`, () => {
      const error = expectParseError(() => parseCategory(raw));
      expect(error.field).toBe('instrumentCategory');
    });
  }

  it('lets an override win over the built-in table', () => {
    expect(parseCategory('Cash', { Cash: 'OTHER' })).toBe('OTHER');
    expect(parseCategory('Cash')).toBe('CASH');
  });

  it('accepts a wording that only the override knows', () => {
    expect(parseCategory('Sovereign Wealth Note', { 'Sovereign Wealth Note': 'OTHER' })).toBe(
      'OTHER',
    );
  });

  it('normalises override keys the same way as input', () => {
    expect(parseCategory('T Bill', { 't-bill': 'REPO' })).toBe('REPO');
    expect(parseCategory('  t-bill  ', { TBILL: 'MMF' })).toBe('MMF');
  });

  it('accepts a lowercase override value', () => {
    expect(parseCategory('Widget', { Widget: 'tbill' })).toBe('TBILL');
  });

  it('rejects an override pointing at a category that does not exist', () => {
    const error = expectParseError(() => parseCategory('Widget', { Widget: 'BONDS' }));
    expect(error.message).toContain('BONDS');
  });

  it('falls through to the built-in table when no override matches', () => {
    expect(parseCategory('repo', { 'money market': 'OTHER' })).toBe('REPO');
  });
});

describe('parseCusip', () => {
  const BLANKS: readonly string[] = ['', '   ', 'N/A', 'n/a', 'NA', 'na', 'NONE', 'none', '-'];

  for (const raw of BLANKS) {
    it(`treats ${JSON.stringify(raw)} as absent`, () => {
      expect(parseCusip(raw)).toBeNull();
    });
  }

  // Real, published CUSIPs. If the check-digit implementation were wrong these
  // would not all validate.
  const VALID: ReadonlyArray<readonly [string, string]> = [
    ['037833100', '037833100'], // Apple Inc
    ['594918104', '594918104'], // Microsoft Corp
    ['46625H100', '46625H100'], // JPMorgan Chase
    ['31846V203', '31846V203'], // Fidelity Government MMF
    ['912828YS3', '912828YS3'], // US Treasury note
    ['912797KL0', '912797KL0'], // US Treasury bill
    ['912797kl0', '912797KL0'], // lowercase is normalised
    ['  912797KL0  ', '912797KL0'],
  ];

  for (const [raw, expected] of VALID) {
    it(`accepts ${JSON.stringify(raw)}`, () => {
      expect(parseCusip(raw)).toBe(expected);
    });
  }

  const INVALID: ReadonlyArray<readonly [string, string]> = [
    ['912797KL5', 'wrong check digit (912797KL requires 0)'],
    ['037833101', 'wrong check digit'],
    ['912828YS4', 'wrong check digit'],
    ['912797LK0', 'transposed K and L — same characters, different security'],
    ['912828SY3', 'transposed S and Y'],
    ['12345678', 'eight characters'],
    ['1234567890', 'ten characters'],
    ['03783310A', 'check digit must be numeric'],
    ['037-833-100', 'punctuation'],
    ['037833 10', 'embedded space'],
    ['ABCDEFGH', 'too short'],
    ['#########', 'unsupported characters'],
    ['0378331OO', 'letter O in the check position'],
  ];

  for (const [raw, why] of INVALID) {
    it(`rejects ${JSON.stringify(raw)} (${why})`, () => {
      const error = expectParseError(() => parseCusip(raw));
      expect(error.field).toBe('cusip');
    });
  }

  it('accepts every CUSIP whose check digit it computes, for all check digits 0-9', () => {
    // Round trip: the only accepted 9th character for a given 8-character body is
    // the computed one, so exactly one of the ten candidates may validate.
    const bodies = ['037833', '594918', '912797', '46625H'].flatMap((prefix) =>
      ['10', 'KL', 'AB', 'Z9'].map((suffix) => prefix + suffix),
    );
    for (const body of bodies) {
      const accepted = '0123456789'.split('').filter((digit) => {
        try {
          return parseCusip(body + digit) !== null;
        } catch {
          return false;
        }
      });
      expect(accepted).toHaveLength(1);
    }
  });
});

describe('mapStatementLine', () => {
  const FULL_MAPPING: StatementMapping = {
    columns: {
      category: 'Asset Type',
      marketValue: 'Market Value',
      faceValue: 'Par Value',
      currency: 'Ccy',
      cusip: 'CUSIP',
      maturityDate: 'Maturity',
    },
    dateFormat: 'US',
    defaultCurrency: 'USD',
  };

  const MINIMAL_MAPPING: StatementMapping = {
    columns: { category: 'type', marketValue: 'value' },
    dateFormat: 'ISO',
    defaultCurrency: 'usd',
  };

  const FULL_ROW: Readonly<Record<string, string>> = {
    'Asset Type': 'Treasury Bill',
    'Market Value': '$1,234,567.89',
    'Par Value': '1,250,000.00',
    Ccy: 'usd',
    CUSIP: '912797kl0',
    Maturity: '03/04/2026',
  };

  it('maps a fully specified row', () => {
    const line = mapStatementLine(FULL_ROW, FULL_MAPPING);
    expect(line.instrumentCategory).toBe('TBILL');
    expect(line.marketValueMinor).toBe(123_456_789n);
    expect(line.faceValueMinor).toBe(125_000_000n);
    expect(line.currency).toBe('USD');
    expect(line.cusip).toBe('912797KL0');
    expect(line.maturityDate?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('applies the configured date format to the maturity column', () => {
    const eu = mapStatementLine(FULL_ROW, { ...FULL_MAPPING, dateFormat: 'EU' });
    expect(eu.maturityDate?.toISOString()).toBe('2026-04-03T00:00:00.000Z');
  });

  it('defaults face value to market value when the column is absent', () => {
    const line = mapStatementLine({ type: 'Cash', value: '500.00' }, MINIMAL_MAPPING);
    expect(line.faceValueMinor).toBe(50_000n);
    expect(line.marketValueMinor).toBe(50_000n);
    expect(line.cusip).toBeNull();
    expect(line.maturityDate).toBeNull();
    expect(line.currency).toBe('USD');
  });

  it('treats a blank maturity cell as no maturity', () => {
    for (const blank of ['', '   ', 'N/A', '-']) {
      const line = mapStatementLine({ ...FULL_ROW, Maturity: blank }, FULL_MAPPING);
      expect(line.maturityDate).toBeNull();
    }
  });

  it('treats a blank CUSIP cell as no CUSIP', () => {
    const line = mapStatementLine({ ...FULL_ROW, CUSIP: 'N/A' }, FULL_MAPPING);
    expect(line.cusip).toBeNull();
  });

  it('accepts a zero market value', () => {
    const line = mapStatementLine({ type: 'Cash', value: '0.00' }, MINIMAL_MAPPING);
    expect(line.marketValueMinor).toBe(0n);
  });

  it('applies category overrides from the mapping', () => {
    const line = mapStatementLine(
      { type: 'Sovereign Wealth Note', value: '1.00' },
      { ...MINIMAL_MAPPING, categoryOverrides: { 'Sovereign Wealth Note': 'OTHER' } },
    );
    expect(line.instrumentCategory).toBe('OTHER');
  });

  it('rejects a negative market value', () => {
    // reserve_facts has CHECK (market_value_minor >= 0); a negative position is a
    // sign-convention or parse error, never a real holding.
    const error = expectParseError(() =>
      mapStatementLine({ ...FULL_ROW, 'Market Value': '(1,000.00)' }, FULL_MAPPING),
    );
    expect(error.field).toBe('marketValueMinor');
  });

  const MISSING_COLUMN_CASES: ReadonlyArray<readonly [string, string]> = [
    ['Asset Type', 'instrumentCategory'],
    ['Market Value', 'marketValueMinor'],
    ['Par Value', 'faceValueMinor'],
    ['Ccy', 'currency'],
    ['CUSIP', 'cusip'],
    ['Maturity', 'maturityDate'],
  ];

  for (const [column, field] of MISSING_COLUMN_CASES) {
    it(`throws naming the missing column ${JSON.stringify(column)}`, () => {
      const row: Record<string, string> = { ...FULL_ROW };
      delete row[column];
      const error = expectParseError(() => mapStatementLine(row, FULL_MAPPING));
      expect(error.field).toBe(field);
      expect(error.message).toContain(column);
    });
  }

  const BAD_CELL_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
    ['Asset Type', 'Corporate Bond', 'instrumentCategory', 'unrecognised category'],
    ['Asset Type', '', 'instrumentCategory', 'blank category'],
    ['Market Value', '', 'marketValueMinor', 'blank market value'],
    ['Market Value', '1.234', 'marketValueMinor', 'sub-cent market value'],
    ['Market Value', 'n/a', 'marketValueMinor', 'placeholder market value'],
    ['Par Value', '1,23,456.00', 'faceValueMinor', 'misgrouped face value'],
    ['Par Value', '(1,250,000.00)', 'faceValueMinor', 'negative face value in accounting parentheses'],
    ['Par Value', '-1,250,000.00', 'faceValueMinor', 'negative face value with a minus sign'],
    ['Ccy', 'US', 'currency', 'two-letter currency'],
    ['Ccy', 'DOLLAR', 'currency', 'currency name rather than code'],
    ['Ccy', '', 'currency', 'blank currency does not fall back to the default'],
    ['CUSIP', '912797KL5', 'cusip', 'bad check digit'],
    ['Maturity', '13/04/2026', 'maturityDate', 'month 13 under the US format'],
    ['Maturity', '2026-03-04', 'maturityDate', 'ISO date under the US format'],
  ];

  for (const [column, value, field, why] of BAD_CELL_CASES) {
    it(`rejects ${JSON.stringify(column)}=${JSON.stringify(value)} (${why})`, () => {
      const error = expectParseError(() =>
        mapStatementLine({ ...FULL_ROW, [column]: value }, FULL_MAPPING),
      );
      expect(error.field).toBe(field);
    });
  }

  it('rejects a mapping whose default currency is not an ISO 4217 code', () => {
    const error = expectParseError(() =>
      mapStatementLine(
        { type: 'Cash', value: '1.00' },
        { ...MINIMAL_MAPPING, defaultCurrency: 'Dollars' },
      ),
    );
    expect(error.field).toBe('defaultCurrency');
  });

  it('rejects a negative face value even though the DB has no CHECK for it', () => {
    // face_value_minor carries no CHECK constraint, so nothing downstream would
    // catch a flipped sign; the row would land in an append-only table that can
    // only be superseded, never corrected.
    const error = expectParseError(() =>
      mapStatementLine({ ...FULL_ROW, 'Par Value': '(1.00)' }, FULL_MAPPING),
    );
    expect(error.field).toBe('faceValueMinor');
    expect(error.message).toContain('negative');
  });

  it('keeps a large market value exact through the whole mapping', () => {
    // 9_999_999_999_999_999 is above 2^53; any float in the path loses cents.
    const line = mapStatementLine(
      { ...FULL_ROW, 'Market Value': '$99,999,999,999,999.99', 'Par Value': '99,999,999,999,999.99' },
      FULL_MAPPING,
    );
    expect(line.marketValueMinor).toBe(9_999_999_999_999_999n);
    expect(line.faceValueMinor).toBe(9_999_999_999_999_999n);
  });

  const PROTOTYPE_COLUMN_NAMES: readonly string[] = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ];

  for (const name of PROTOTYPE_COLUMN_NAMES) {
    it(`reports a missing column named ${JSON.stringify(name)} as absent, not as a crash`, () => {
      // A bare `fields[column]` lookup walks the prototype chain and hands the
      // parser a function, which dies with a TypeError past any
      // ValueParseError handler the ingestion worker wraps the file in.
      const error = expectParseError(() =>
        mapStatementLine(
          { type: 'Cash', value: '1.00' },
          { ...MINIMAL_MAPPING, columns: { category: 'type', marketValue: 'value', cusip: name } },
        ),
      );
      expect(error.field).toBe('cusip');
      expect(error.message).toContain(name);
    });
  }

  it('does not mutate the input row', () => {
    const row = { ...FULL_ROW };
    mapStatementLine(row, FULL_MAPPING);
    expect(row).toEqual(FULL_ROW);
  });
});
