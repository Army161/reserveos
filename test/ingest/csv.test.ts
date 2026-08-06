import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv, parseCsvTable } from '../../src/ingest/csv.js';

const BOM = '\uFEFF';

/** Runs `fn`, asserts it threw a CsvParseError, and returns it for positional assertions. */
function csvError(fn: () => unknown): CsvParseError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CsvParseError) return err;
    throw err;
  }
  throw new Error('expected a CsvParseError, but nothing was thrown');
}

describe('parseCsv — structure', () => {
  it('parses a plain grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('returns [] for input that is nothing but a BOM', () => {
    expect(parseCsv(BOM)).toEqual([]);
  });

  it('parses a single field with no delimiters at all', () => {
    expect(parseCsv('solo')).toEqual([['solo']]);
  });

  it('preserves trailing empty fields', () => {
    expect(parseCsv('a,,,')).toEqual([['a', '', '', '']]);
  });

  it('preserves leading and interior empty fields', () => {
    expect(parseCsv(',a,,b')).toEqual([['', 'a', '', 'b']]);
  });
});

describe('parseCsv — quoting', () => {
  it('keeps a comma inside a quoted field instead of splitting on it', () => {
    expect(parseCsv('pos,"1,234,567.89"')).toEqual([['pos', '1,234,567.89']]);
  });

  it('keeps an LF inside a quoted field', () => {
    expect(parseCsv('a,"line1\nline2",b')).toEqual([['a', 'line1\nline2', 'b']]);
  });

  it('normalizes a CRLF inside a quoted field to LF', () => {
    // Determinism: the same statement re-sent from a Windows host must yield a
    // byte-identical field, or its source hash changes and it re-ingests as new.
    expect(parseCsv('a,"line1\r\nline2",b')).toEqual([['a', 'line1\nline2', 'b']]);
  });

  it('normalizes a lone CR inside a quoted field to LF', () => {
    expect(parseCsv('a,"line1\rline2",b')).toEqual([['a', 'line1\nline2', 'b']]);
  });

  it('unescapes a doubled quote to a single literal quote', () => {
    expect(parseCsv('"he said ""hi""",x')).toEqual([['he said "hi"', 'x']]);
  });

  it('handles a field that is only a doubled quote', () => {
    expect(parseCsv('"""",x')).toEqual([['"', 'x']]);
  });

  it('treats an exactly-empty quoted field as an empty string, not a missing row', () => {
    expect(parseCsv('""')).toEqual([['']]);
    expect(parseCsv('a,"",b')).toEqual([['a', '', 'b']]);
  });

  it('handles a quoted field containing delimiter, quotes and newline together', () => {
    expect(parseCsv('"a,b\n""c"",d"')).toEqual([['a,b\n"c",d']]);
  });

  it('allows a quoted field to be the last field with no trailing delimiter', () => {
    expect(parseCsv('a,"b,c"')).toEqual([['a', 'b,c']]);
  });

  it('allows a row of entirely quoted fields', () => {
    expect(parseCsv('"a","b"\n"c","d"')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseCsv — line endings', () => {
  it('splits on LF', () => {
    expect(parseCsv('a\nb\nc')).toEqual([['a'], ['b'], ['c']]);
  });

  it('splits on CRLF and does not leave a stray CR in the value', () => {
    expect(parseCsv('a\r\nb\r\nc')).toEqual([['a'], ['b'], ['c']]);
  });

  it('splits on a lone CR', () => {
    expect(parseCsv('a\rb\rc')).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles a file with mixed line endings', () => {
    expect(parseCsv('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });
});

describe('parseCsv — BOM and trailing newlines', () => {
  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv(`${BOM}as_of,amount\n2026-06-30,100`)).toEqual([
      ['as_of', 'amount'],
      ['2026-06-30', '100'],
    ]);
  });

  it('does not strip a BOM that is not at the very start', () => {
    expect(parseCsv(`a,${BOM}b`)).toEqual([['a', `${BOM}b`]]);
  });

  it('does not produce an extra row for a trailing LF', () => {
    expect(parseCsv('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not produce an extra row for a trailing CRLF', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not produce an extra row for a trailing CR', () => {
    expect(parseCsv('a,b\rc,d\r')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a blank line in the middle as an empty row rather than dropping data', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([['a', 'b'], [''], ['c', 'd']]);
  });

  it('keeps consecutive blank middle lines', () => {
    expect(parseCsv('a\n\n\nb')).toEqual([['a'], [''], [''], ['b']]);
  });

  it('keeps a blank line that precedes the trailing newline', () => {
    // Only the zero-length segment after the final terminator is dropped. A
    // genuinely blank penultimate line still surfaces, and parseCsvTable then
    // rejects it loudly rather than silently omitting a row.
    expect(parseCsv('a,b\n\n')).toEqual([['a', 'b'], ['']]);
  });

  it('treats a file containing only a newline as one empty row', () => {
    expect(parseCsv('\n')).toEqual([['']]);
  });
});

describe('parseCsv — unicode', () => {
  it('round-trips CJK headers and values unchanged', () => {
    expect(parseCsv('名称,金額\n"ドル建て準備金","¥1,000"\n')).toEqual([
      ['名称', '金額'],
      ['ドル建て準備金', '¥1,000'],
    ]);
  });

  it('splits on a delimiter that follows a multi-byte character', () => {
    expect(parseCsv('準備金,€100')).toEqual([['準備金', '€100']]);
  });

  it('keeps astral-plane characters intact inside a quoted field', () => {
    const value = '💵 reserve — café';
    expect(parseCsv(`a,"${value}"`)).toEqual([['a', value]]);
  });

  it('does not treat a non-ASCII whitespace-looking character as a terminator', () => {
    // U+2028 LINE SEPARATOR is a line terminator in JS source but not in CSV.
    expect(parseCsv('a\u2028b')).toEqual([['a\u2028b']]);
  });
});

describe('parseCsv — options', () => {
  it('accepts a semicolon delimiter', () => {
    expect(parseCsv('a;b;c', { delimiter: ';' })).toEqual([['a', 'b', 'c']]);
  });

  it('accepts a tab delimiter and leaves commas alone', () => {
    expect(parseCsv('a\t1,234\tb', { delimiter: '\t' })).toEqual([['a', '1,234', 'b']]);
  });

  it('still honours quoting with a custom delimiter', () => {
    expect(parseCsv('"x;y";z', { delimiter: ';' })).toEqual([['x;y', 'z']]);
  });

  it('preserves surrounding whitespace by default', () => {
    expect(parseCsv(' a , b ')).toEqual([[' a ', ' b ']]);
  });

  it('trims unquoted fields when trimWhitespace is set', () => {
    expect(parseCsv(' a ,\tb\t', { trimWhitespace: true })).toEqual([['a', 'b']]);
  });

  it('never trims inside a quoted field, even with trimWhitespace set', () => {
    // The quotes are the custodian stating that the padding is part of the value.
    expect(parseCsv('" a ", b ', { trimWhitespace: true })).toEqual([[' a ', 'b']]);
  });

  it('collapses a whitespace-only unquoted field to empty when trimming', () => {
    expect(parseCsv('a,   ,b', { trimWhitespace: true })).toEqual([['a', '', 'b']]);
    expect(parseCsv('a,   ,b')).toEqual([['a', '   ', 'b']]);
  });

  it('rejects a delimiter that is not exactly one character', () => {
    expect(() => parseCsv('a,b', { delimiter: '' })).toThrow(RangeError);
    expect(() => parseCsv('a,b', { delimiter: '||' })).toThrow(RangeError);
  });

  it('rejects a delimiter that would collide with quoting or line endings', () => {
    expect(() => parseCsv('a,b', { delimiter: '"' })).toThrow(RangeError);
    expect(() => parseCsv('a,b', { delimiter: '\n' })).toThrow(RangeError);
    expect(() => parseCsv('a,b', { delimiter: '\r' })).toThrow(RangeError);
  });
});

describe('parseCsv — malformed input is loud', () => {
  it('reports an unterminated quote at the line and column where it opened', () => {
    const err = csvError(() => parseCsv('a,b\nc,"d,e\nf,g'));
    expect(err.line).toBe(2);
    expect(err.column).toBe(3);
    expect(err.message).toContain('unterminated');
  });

  it('reports an unterminated quote that opens on the first line', () => {
    const err = csvError(() => parseCsv('"abc'));
    expect(err.line).toBe(1);
    expect(err.column).toBe(1);
  });

  it('treats a lone quote at EOF as unterminated rather than an empty field', () => {
    expect(() => parseCsv('a,"')).toThrow(CsvParseError);
  });

  it('rejects a stray quote inside an unquoted field', () => {
    const err = csvError(() => parseCsv('a,b"c'));
    expect(err.line).toBe(1);
    expect(err.column).toBe(4);
    expect(err.message).toContain('unquoted field');
  });

  it('reports a stray quote on the correct later line', () => {
    const err = csvError(() => parseCsv('a,b\r\nc,d"e'));
    expect(err.line).toBe(2);
    expect(err.column).toBe(4);
  });

  it('rejects text after a closing quote', () => {
    const err = csvError(() => parseCsv('"ab"c'));
    expect(err.line).toBe(1);
    expect(err.column).toBe(5);
    expect(err.message).toContain('closing double quote');
  });

  it('rejects a quote that opens mid-field even when it later closes', () => {
    expect(() => parseCsv('a,1"234",b')).toThrow(CsvParseError);
  });

  it('rejects whitespace between the delimiter and an opening quote', () => {
    // ` "b"` is an unquoted field containing quotes; guessing that the author
    // meant a quoted field would let a padded delimiter change the column count.
    expect(() => parseCsv('a, "b,c"')).toThrow(CsvParseError);
  });

  it('is an Error subclass carrying its position in the message', () => {
    const err = csvError(() => parseCsv('a"b'));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CsvParseError');
    expect(err.message).toContain('line 1, column 2');
  });

  it('returns ragged rows as-is rather than validating them', () => {
    expect(parseCsv('a,b,c\n1,2\n3,4,5,6')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['3', '4', '5', '6'],
    ]);
  });
});

describe('parseCsvTable — headers', () => {
  it('exposes headers and rows', () => {
    const table = parseCsvTable('as_of,amount\n2026-06-30,100\n2026-06-30,200\n');
    expect(table.headers).toEqual(['as_of', 'amount']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.get('amount')).toBe('100');
    expect(table.rows[1]!.get('amount')).toBe('200');
  });

  it('accepts a header-only file as a table with no rows', () => {
    const table = parseCsvTable('as_of,amount');
    expect(table.headers).toEqual(['as_of', 'amount']);
    expect(table.rows).toEqual([]);
  });

  it('throws on empty input instead of returning an empty table', () => {
    const err = csvError(() => parseCsvTable(''));
    expect(err.message).toContain('empty CSV');
  });

  it('throws on BOM-only input', () => {
    expect(() => parseCsvTable(BOM)).toThrow(CsvParseError);
  });

  it('trims surrounding whitespace from the exposed header names', () => {
    const table = parseCsvTable(' as_of , market_value \nx,y');
    expect(table.headers).toEqual(['as_of', 'market_value']);
  });

  it('strips a BOM so the first column is still addressable', () => {
    const table = parseCsvTable(`${BOM}as_of,amount\n2026-06-30,100`);
    expect(table.headers[0]).toBe('as_of');
    expect(table.rows[0]!.get('as_of')).toBe('2026-06-30');
  });

  it('looks up headers case-insensitively and ignoring surrounding whitespace', () => {
    const table = parseCsvTable('Market_Value\n100');
    const row = table.rows[0]!;
    expect(row.get('market_value')).toBe('100');
    expect(row.get('MARKET_VALUE')).toBe('100');
    expect(row.get('  Market_Value  ')).toBe('100');
  });

  it('does not trim or fold case in the VALUES, only in the header names', () => {
    const table = parseCsvTable('Name\n  Bny Mellon  ');
    expect(table.rows[0]!.get('name')).toBe('  Bny Mellon  ');
  });

  it('rejects exactly duplicated headers', () => {
    const err = csvError(() => parseCsvTable('amount,amount\n1,2'));
    expect(err.line).toBe(1);
    expect(err.message).toContain('duplicate header');
    expect(err.message).toContain('columns 1 and 2');
  });

  it('rejects headers that differ only by case or padding', () => {
    expect(() => parseCsvTable('Amount, amount \n1,2')).toThrow(CsvParseError);
    expect(() => parseCsvTable('cusip,CUSIP\n1,2')).toThrow(CsvParseError);
  });

  it('rejects duplicated empty headers', () => {
    expect(() => parseCsvTable('a,,\n1,2,3')).toThrow(CsvParseError);
  });
});

describe('parseCsvTable — options reach the parser', () => {
  // parseCsvTable takes the same options as parseCsv and must forward them. If it
  // dropped them, a semicolon-delimited European statement would parse as ONE
  // column whose header is the whole line, and the misalignment this module exists
  // to prevent would arrive through the table API instead.
  it('honours a custom delimiter for both the header and the rows', () => {
    const table = parseCsvTable('as_of;market_value\n2026-06-30;100', { delimiter: ';' });
    expect(table.headers).toEqual(['as_of', 'market_value']);
    expect(table.rows[0]!.get('market_value')).toBe('100');
  });

  it('honours quoting under a custom delimiter', () => {
    const table = parseCsvTable('custodian;market_value\n"Mellon;N.A.";100', { delimiter: ';' });
    expect(table.rows[0]!.get('custodian')).toBe('Mellon;N.A.');
    expect(table.rows[0]!.get('market_value')).toBe('100');
  });

  it('honours trimWhitespace on VALUES, not only on header names', () => {
    // Header names are always trimmed, so only a value can distinguish "the
    // option was forwarded" from "the option was ignored".
    const padded = 'as_of,market_value\n 2026-06-30 , 100 ';
    expect(parseCsvTable(padded, { trimWhitespace: true }).rows[0]!.get('market_value')).toBe('100');
    expect(parseCsvTable(padded).rows[0]!.get('market_value')).toBe(' 100 ');
  });

  it('validates the delimiter on this path too', () => {
    expect(() => parseCsvTable('a|b', { delimiter: '||' })).toThrow(RangeError);
    expect(() => parseCsvTable('a,b', { delimiter: '"' })).toThrow(RangeError);
  });
});

describe('parseCsvTable — rows', () => {
  it('reports whether a column exists', () => {
    const row = parseCsvTable('as_of,amount\n2026-06-30,100').rows[0]!;
    expect(row.has('amount')).toBe(true);
    expect(row.has('AMOUNT')).toBe(true);
    expect(row.has('maturity')).toBe(false);
  });

  it('throws a RangeError for an unknown column rather than returning undefined', () => {
    const row = parseCsvTable('as_of,amount\n2026-06-30,100').rows[0]!;
    expect(() => row.get('maturity')).toThrow(RangeError);
    expect(() => row.get('maturity')).toThrow(/maturity/);
  });

  it('exposes the raw field array in file order', () => {
    const row = parseCsvTable('a,b,c\n1,2,3').rows[0]!;
    expect(row.raw).toEqual(['1', '2', '3']);
  });

  it('numbers rows by physical line', () => {
    const table = parseCsvTable('a,b\n1,2\n3,4');
    expect(table.rows.map((r) => r.lineNumber)).toEqual([2, 3]);
  });

  it('advances line numbers past newlines embedded in quoted fields', () => {
    const table = parseCsvTable('note,code\n"first\nsecond",X\nplain,Y');
    expect(table.rows[0]!.lineNumber).toBe(2);
    expect(table.rows[0]!.get('note')).toBe('first\nsecond');
    expect(table.rows[1]!.lineNumber).toBe(4);
    expect(table.rows[1]!.get('code')).toBe('Y');
  });
});

describe('parseCsvTable — ragged rows', () => {
  it('throws on a short row, naming the line and both counts', () => {
    const err = csvError(() => parseCsvTable('a,b,c\n1,2,3\n4,5\n'));
    expect(err.line).toBe(3);
    expect(err.message).toContain('expected 3 fields');
    expect(err.message).toContain('found 2');
  });

  it('throws on a long row', () => {
    const err = csvError(() => parseCsvTable('a,b\n1,2,3'));
    expect(err.line).toBe(2);
    expect(err.message).toContain('expected 2 fields');
    expect(err.message).toContain('found 3');
  });

  it('throws on a blank line in the middle rather than skipping it', () => {
    const err = csvError(() => parseCsvTable('a,b\n1,2\n\n3,4'));
    expect(err.line).toBe(3);
    expect(err.message).toContain('found 1');
  });

  it('accepts a file whose last row is followed by a newline', () => {
    const table = parseCsvTable('a,b\n1,2\n');
    expect(table.rows).toHaveLength(1);
  });

  it('reports the line of the ragged row when an earlier row spanned lines', () => {
    const err = csvError(() => parseCsvTable('a,b\n"x\ny",2\n3'));
    expect(err.line).toBe(4);
  });
});

describe('a realistic custodian statement', () => {
  const HEADER =
    'as_of,custodian,instrument,cusip,currency,face_value,market_value,maturity';
  const TBILL =
    '2026-06-30,"Bank of New York Mellon, N.A.",TBILL,912797LN2,USD,"1,234,567.89","1,233,001.10",2026-09-24';
  const CASH = '2026-06-30,"State Street Bank & Trust",CASH,,USD,"500,000.00","500,000.00",';
  const statement = `${BOM}${HEADER}\r\n${TBILL}\r\n${CASH}\r\n`;

  it('parses the declared number of columns despite embedded commas', () => {
    const rows = parseCsv(statement);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.length === 8)).toBe(true);
  });

  it('is the exact case a naive split(",") corrupts', () => {
    // The whole reason this module exists: split(',') yields a different column
    // count, so every field after the custodian name lands one column too far left.
    // Assert BOTH halves — the naive corruption and the correct parse — so this
    // test fails if the parser ever regresses to the naive behaviour.
    const naive = TBILL.split(',');
    expect(naive.length).not.toBe(8);
    expect(naive[1]).toBe('"Bank of New York Mellon');

    const parsed = parseCsv(TBILL)[0]!;
    expect(parsed).toHaveLength(8);
    expect(parsed[1]).toBe('Bank of New York Mellon, N.A.');
    expect(parsed[6]).toBe('1,233,001.10');
  });

  it('keeps thousands separators inside the amount fields', () => {
    const table = parseCsvTable(statement);
    const tbill = table.rows[0]!;
    expect(tbill.get('face_value')).toBe('1,234,567.89');
    expect(tbill.get('market_value')).toBe('1,233,001.10');
  });

  it('keeps the comma inside a custodian legal name', () => {
    const table = parseCsvTable(statement);
    expect(table.rows[0]!.get('custodian')).toBe('Bank of New York Mellon, N.A.');
    expect(table.rows[1]!.get('custodian')).toBe('State Street Bank & Trust');
  });

  it('yields empty strings for genuinely absent optional columns', () => {
    const table = parseCsvTable(statement);
    const cash = table.rows[1]!;
    expect(cash.get('cusip')).toBe('');
    expect(cash.get('maturity')).toBe('');
  });

  it('reads every column of a row by name', () => {
    const table = parseCsvTable(statement);
    const tbill = table.rows[0]!;
    expect(table.headers.map((h) => tbill.get(h))).toEqual([
      '2026-06-30',
      'Bank of New York Mellon, N.A.',
      'TBILL',
      '912797LN2',
      'USD',
      '1,234,567.89',
      '1,233,001.10',
      '2026-09-24',
    ]);
  });

  it('rejects the same statement if one row loses a column', () => {
    const damaged = `${HEADER}\r\n${TBILL.replace(',912797LN2', '')}\r\n`;
    const err = csvError(() => parseCsvTable(damaged));
    expect(err.line).toBe(2);
    expect(err.message).toContain('misaligned column');
  });

  it('rejects the same statement if a quote is dropped', () => {
    const damaged = `${HEADER}\r\n${TBILL.replace('"1,234,567.89"', '1,234,567.89')}\r\n`;
    // Without the quotes this row simply has more columns than the header.
    expect(() => parseCsvTable(damaged)).toThrow(CsvParseError);
  });
});
