/**
 * Custodian statement value parsing and column mapping.
 *
 * Every custodian formats amounts and dates differently. This module turns raw
 * statement strings into exact domain values, and refuses anything ambiguous.
 * A misparse here is a wrong number on a report a CEO signs under criminal
 * liability, so every function fails loudly rather than guessing.
 */

import { INSTRUMENT_CATEGORIES, type InstrumentCategory } from '../domain/types.js';

export class ValueParseError extends Error {
  readonly field: string;
  readonly raw: string;

  constructor(field: string, raw: string, reason: string) {
    super(`${field}: ${reason} (raw: ${JSON.stringify(raw)})`);
    this.name = 'ValueParseError';
    this.field = field;
    this.raw = raw;
  }
}

/* ------------------------------------------------------------------ amounts */

/** Grouped thousands: a 1-3 digit lead group followed by exact groups of 3. */
const GROUPED_INTEGER = /^\d{1,3}(?:,\d{3})+$/;
const PLAIN_INTEGER = /^\d+$/;

/**
 * Parse a statement amount into exact minor units (cents).
 *
 * `'1,234,567.89'` -> `123456789n`, `'(500.00)'` -> `-50000n`, `'$1,000'` -> `100000n`.
 *
 * The integer and fraction parts are combined as strings and converted with
 * `BigInt`; `Number`/`parseFloat` would silently lose precision above 2^53,
 * which a reserve total in cents reaches at roughly $90bn.
 */
export function parseAmountToMinor(raw: string, field = 'amount'): bigint {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ValueParseError(field, raw, 'value is empty');

  let body = trimmed;

  const opensParen = body.startsWith('(');
  const closesParen = body.endsWith(')');
  if (opensParen !== closesParen) {
    throw new ValueParseError(field, raw, 'unbalanced accounting parentheses');
  }

  const parenthesised = opensParen && closesParen;
  if (parenthesised) body = body.slice(1, -1).trim();

  let signed = false;
  let symbolSeen = false;
  for (;;) {
    if (body.startsWith('-') && !signed) {
      signed = true;
      body = body.slice(1).trimStart();
      continue;
    }
    if (body.startsWith('$') && !symbolSeen) {
      symbolSeen = true;
      body = body.slice(1).trimStart();
      continue;
    }
    break;
  }

  // Two negation markers on one value means the statement layout was
  // misunderstood; guessing which one is authoritative could flip a sign.
  if (parenthesised && signed) {
    throw new ValueParseError(field, raw, 'both a minus sign and accounting parentheses');
  }
  if (body === '') throw new ValueParseError(field, raw, 'no digits in value');

  const parts = body.split('.');
  if (parts.length > 2) throw new ValueParseError(field, raw, 'multiple decimal points');

  const integerPart = parts[0]!;
  const fractionPart = parts.length === 2 ? parts[1]! : null;

  if (integerPart === '') throw new ValueParseError(field, raw, 'no digits before the decimal point');
  if (!PLAIN_INTEGER.test(integerPart) && !GROUPED_INTEGER.test(integerPart)) {
    throw new ValueParseError(
      field,
      raw,
      integerPart.includes(',')
        ? 'thousands separators must group exactly three digits'
        : 'integer part is not numeric',
    );
  }

  let fractionDigits = '00';
  if (fractionPart !== null) {
    if (fractionPart === '') throw new ValueParseError(field, raw, 'trailing decimal point');
    if (!PLAIN_INTEGER.test(fractionPart)) {
      throw new ValueParseError(field, raw, 'fraction part is not numeric');
    }
    // Rounding a third decimal away would lose sub-cent money and, worse, hide a
    // unit mismatch (a value quoted in a different scale reads as a valid amount).
    if (fractionPart.length > 2) {
      throw new ValueParseError(
        field,
        raw,
        `${fractionPart.length} decimal places; minor units allow at most 2`,
      );
    }
    fractionDigits = fractionPart.padEnd(2, '0');
  }

  const magnitude = BigInt(integerPart.replaceAll(',', '') + fractionDigits);
  return parenthesised || signed ? -magnitude : magnitude;
}

/* -------------------------------------------------------------------- dates */

/** `YYYY-MM-DD` | `MM/DD/YYYY` | `DD/MM/YYYY`. */
export type DateFormat = 'ISO' | 'US' | 'EU';

// The backreference forces one separator style per value: `2026-01/15` is a
// corrupted field, not a date. A 2-digit year is rejected outright ('26' could
// be 1926 or 2026) but zero-padding is optional, since the explicit format
// already says which component is which.
const DATE_PATTERNS: Readonly<Record<DateFormat, RegExp>> = {
  ISO: /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/,
  US: /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/,
  EU: /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/,
};

const DATE_SHAPES: Readonly<Record<DateFormat, string>> = {
  ISO: 'YYYY-MM-DD',
  US: 'MM/DD/YYYY',
  EU: 'DD/MM/YYYY',
};

/**
 * Parse a statement date at UTC midnight.
 *
 * `format` must come from the custodian's configuration and is never inferred:
 * `03/04/2026` is 4 March under EU and 3 April under US, and there is nothing in
 * the value itself that distinguishes the two.
 *
 * `new Date(string)` is never used — its behaviour on non-ISO input is
 * implementation-defined and locale-sensitive.
 */
export function parseStatementDate(raw: string, format: DateFormat, field = 'date'): Date {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ValueParseError(field, raw, 'value is empty');

  const match = DATE_PATTERNS[format].exec(trimmed);
  if (match === null) {
    throw new ValueParseError(field, raw, `does not match ${format} format ${DATE_SHAPES[format]}`);
  }

  const a = Number(match[1]!);
  const b = Number(match[3]!);
  const c = Number(match[4]!);

  const year = format === 'ISO' ? a : c;
  const month = format === 'EU' ? b : format === 'US' ? a : b;
  const day = format === 'EU' ? a : format === 'US' ? b : c;

  if (month < 1 || month > 12) throw new ValueParseError(field, raw, `month ${month} is out of range`);
  if (day < 1 || day > 31) throw new ValueParseError(field, raw, `day ${day} is out of range`);

  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC overflows silently (Feb 30 becomes Mar 2) and remaps years 0-99
  // into the 1900s, so the only safe validation is a round trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValueParseError(field, raw, 'not a real calendar date');
  }

  return date;
}

/* --------------------------------------------------------------- categories */

/**
 * Built-in custodian wordings, keyed by their normalised form so that
 * `T-Bill`, `t bill` and `TBILL` all collapse to one entry.
 *
 * There is deliberately no entry mapping the literal word "other" to `OTHER`:
 * `OTHER` is ineligible under GENIUS Act s.4, so producing it from a vague
 * label would fire a CRITICAL breach nobody reviewed. An issuer that really
 * holds an other-category instrument must say so through `categoryOverrides`.
 */
const BUILT_IN_CATEGORIES: ReadonlyMap<string, InstrumentCategory> = new Map([
  ['cash', 'CASH'],
  ['deposit', 'CASH'],
  ['deposits', 'CASH'],
  ['demanddeposit', 'CASH'],
  ['demanddeposits', 'CASH'],
  ['bankdeposit', 'CASH'],
  ['cashdeposit', 'CASH'],

  ['federalreserve', 'FED_DEPOSIT'],
  ['federalreservedeposit', 'FED_DEPOSIT'],
  ['feddeposit', 'FED_DEPOSIT'],
  ['reservebalance', 'FED_DEPOSIT'],
  ['reservebalances', 'FED_DEPOSIT'],
  ['federalreservebalance', 'FED_DEPOSIT'],

  ['treasurybill', 'TBILL'],
  ['treasurybills', 'TBILL'],
  ['tbill', 'TBILL'],
  ['tbills', 'TBILL'],
  ['ustreasury', 'TBILL'],
  ['ustreasurybill', 'TBILL'],
  ['bill', 'TBILL'],

  ['moneymarket', 'MMF'],
  ['moneymarketfund', 'MMF'],
  ['mmf', 'MMF'],
  ['governmentmoneymarketfund', 'MMF'],
  ['govtmoneymarketfund', 'MMF'],

  ['repo', 'REPO'],
  ['repos', 'REPO'],
  ['repurchaseagreement', 'REPO'],
  ['reverserepo', 'REPO'],
  ['reverserepurchaseagreement', 'REPO'],
]);

const CATEGORY_SET: ReadonlySet<string> = new Set(INSTRUMENT_CATEGORIES);

/** Case-, space- and punctuation-insensitive key for category lookup. */
function normaliseCategoryKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Map a custodian's instrument wording to an `InstrumentCategory`.
 *
 * `overrides` is per-custodian configuration and wins over the built-in table.
 * An unrecognised wording throws: mapping it to `OTHER` would mark real
 * eligible collateral ineligible and fire a false CRITICAL breach, while
 * mapping it to a permitted category would conceal a real one. Refusing the row
 * is the only outcome that cannot produce a wrong certified report.
 */
export function parseCategory(
  raw: string,
  overrides?: Readonly<Record<string, string>>,
): InstrumentCategory {
  const key = normaliseCategoryKey(raw);
  if (key === '') throw new ValueParseError('instrumentCategory', raw, 'value is empty');

  if (overrides !== undefined) {
    for (const [overrideKey, overrideValue] of Object.entries(overrides)) {
      if (normaliseCategoryKey(overrideKey) !== key) continue;
      const candidate = overrideValue.trim().toUpperCase();
      if (!CATEGORY_SET.has(candidate)) {
        throw new ValueParseError(
          'instrumentCategory',
          raw,
          `override maps to ${JSON.stringify(overrideValue)}, which is not an instrument category`,
        );
      }
      return candidate as InstrumentCategory;
    }
  }

  const builtIn = BUILT_IN_CATEGORIES.get(key);
  if (builtIn !== undefined) return builtIn;

  throw new ValueParseError(
    'instrumentCategory',
    raw,
    'unrecognised instrument category; add a categoryOverrides entry for this custodian',
  );
}

/* -------------------------------------------------------------------- cusip */

const CUSIP_SHAPE = /^[0-9A-Z]{8}[0-9]$/;

/** Statement placeholders that mean "this instrument has no CUSIP". */
const CUSIP_BLANKS: ReadonlySet<string> = new Set(['', 'N/A', 'NA', 'NONE', '-']);

/** CUSIP character values: digits are themselves, `A`-`Z` are 10-35. */
function cusipCharValue(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 65 + 10;
  throw new RangeError(`invalid CUSIP character ${JSON.stringify(char)}`);
}

/**
 * Modulus-10 double-add-double check digit over the 8 significant characters.
 * Callers must have validated the shape first.
 */
function cusipCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const value = cusipCharValue(body[i]!);
    // Positions are 1-indexed in the standard; every second character doubles.
    const weighted = i % 2 === 1 ? value * 2 : value;
    sum += Math.floor(weighted / 10) + (weighted % 10);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Parse and validate a CUSIP, returning null when the statement has none.
 *
 * The check digit is verified rather than merely the shape: a transposition
 * (`...KL5` typed as `...LK5`) is still nine valid characters, and would
 * silently attribute a holding to a different security.
 */
export function parseCusip(raw: string): string | null {
  const candidate = raw.trim().toUpperCase();
  if (CUSIP_BLANKS.has(candidate)) return null;

  if (!CUSIP_SHAPE.test(candidate)) {
    throw new ValueParseError('cusip', raw, 'not 8 alphanumerics followed by a check digit');
  }

  const expected = cusipCheckDigit(candidate.slice(0, 8));
  const actual = Number(candidate[8]!);
  if (expected !== actual) {
    throw new ValueParseError(
      'cusip',
      raw,
      `check digit ${actual} is wrong; ${candidate.slice(0, 8)} requires ${expected}`,
    );
  }

  return candidate;
}

/* ------------------------------------------------------------ line mapping */

export interface StatementMapping {
  readonly columns: {
    readonly category: string;
    readonly marketValue: string;
    readonly faceValue?: string;
    readonly currency?: string;
    readonly cusip?: string;
    readonly maturityDate?: string;
  };
  readonly dateFormat: DateFormat;
  /** ISO 4217, used when the statement has no currency column. */
  readonly defaultCurrency: string;
  readonly categoryOverrides?: Readonly<Record<string, string>>;
}

export interface MappedLine {
  instrumentCategory: InstrumentCategory;
  cusip: string | null;
  currency: string;
  faceValueMinor: bigint;
  marketValueMinor: bigint;
  maturityDate: Date | null;
}

const CURRENCY_SHAPE = /^[A-Z]{3}$/;

/** Values that mean "no maturity" for instruments such as cash. */
const MATURITY_BLANKS: ReadonlySet<string> = new Set(['', 'N/A', 'NA', 'NONE', '-']);

function requireColumn(
  fields: Readonly<Record<string, string>>,
  column: string,
  field: string,
): string {
  // `fields[column]` alone walks the prototype chain, so a column named after an
  // Object.prototype member ('constructor', 'toString', 'valueOf') resolves to a
  // function instead of being reported as absent. That escapes as a TypeError
  // from the parser below, past the ValueParseError handler an ingestion worker
  // wraps the file in, and kills the run instead of failing the file cleanly.
  const value = Object.hasOwn(fields, column) ? fields[column] : undefined;
  if (value === undefined) {
    throw new ValueParseError(field, '', `column ${JSON.stringify(column)} is missing from the row`);
  }
  return value;
}

function parseCurrency(raw: string, field: string): string {
  const candidate = raw.trim().toUpperCase();
  if (!CURRENCY_SHAPE.test(candidate)) {
    throw new ValueParseError(field, raw, 'not a 3-letter ISO 4217 code');
  }
  return candidate;
}

/**
 * Project one raw statement row onto domain values using a custodian's mapping.
 *
 * A column named in the mapping but absent from the row is a mapping/file
 * mismatch, not a blank cell, so it throws rather than defaulting.
 */
export function mapStatementLine(
  fields: Readonly<Record<string, string>>,
  mapping: StatementMapping,
): MappedLine {
  const { columns } = mapping;

  const instrumentCategory = parseCategory(
    requireColumn(fields, columns.category, 'instrumentCategory'),
    mapping.categoryOverrides,
  );

  const marketValueMinor = parseAmountToMinor(
    requireColumn(fields, columns.marketValue, 'marketValueMinor'),
    'marketValueMinor',
  );
  // reserve_facts has CHECK (market_value_minor >= 0); a negative reserve
  // position is a parse or sign-convention error, never a real holding.
  if (marketValueMinor < 0n) {
    throw new ValueParseError(
      'marketValueMinor',
      fields[columns.marketValue] ?? '',
      'market value is negative',
    );
  }

  // Instruments carried at par (cash, deposits) often omit face value entirely.
  const faceValueMinor =
    columns.faceValue === undefined
      ? marketValueMinor
      : parseAmountToMinor(
          requireColumn(fields, columns.faceValue, 'faceValueMinor'),
          'faceValueMinor',
        );
  // Same reasoning as the market value: a negative par amount is a sign-convention
  // or column-misalignment error, never a real holding. reserve_facts has no
  // CHECK on face_value_minor, so nothing downstream would catch it — the row
  // would land in an append-only table that can only be superseded, never fixed.
  if (faceValueMinor < 0n) {
    throw new ValueParseError(
      'faceValueMinor',
      columns.faceValue === undefined ? '' : (fields[columns.faceValue] ?? ''),
      'face value is negative',
    );
  }

  const currency =
    columns.currency === undefined
      ? parseCurrency(mapping.defaultCurrency, 'defaultCurrency')
      : parseCurrency(requireColumn(fields, columns.currency, 'currency'), 'currency');

  const cusip =
    columns.cusip === undefined ? null : parseCusip(requireColumn(fields, columns.cusip, 'cusip'));

  let maturityDate: Date | null = null;
  if (columns.maturityDate !== undefined) {
    const rawMaturity = requireColumn(fields, columns.maturityDate, 'maturityDate');
    maturityDate = MATURITY_BLANKS.has(rawMaturity.trim().toUpperCase())
      ? null
      : parseStatementDate(rawMaturity, mapping.dateFormat, 'maturityDate');
  }

  return { instrumentCategory, cusip, currency, faceValueMinor, marketValueMinor, maturityDate };
}
