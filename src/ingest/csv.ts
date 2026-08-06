/**
 * Strict RFC 4180 CSV parser.
 *
 * Custodian statements arrive as CSV and are the only input to the reserve
 * total. A naive `line.split(',')` turns a quoted position of "1,234,567.89"
 * into three bogus columns, shifting every later value one column left; the
 * resulting report is wrong and nothing about it looks wrong. So this parser
 * refuses every ambiguous construct rather than guessing at intent.
 *
 * Error taxonomy:
 *   - `CsvParseError` means the DATA is bad (malformed quoting, ragged row,
 *     ambiguous headers). Callers ingesting a statement should catch this.
 *   - `RangeError` means the CALLER is wrong (nonsense delimiter, asking a row
 *     for a column that does not exist). That is a bug, not a bad statement,
 *     and it should escape an ingestion try/catch.
 */

const QUOTE = '"';
const CR = '\r';
const LF = '\n';
/** U+FEFF. Written as an escape so it is visible in a diff. */
const BOM = '\uFEFF';

export interface CsvOptions {
  /** Single character. Defaults to ','. */
  readonly delimiter?: string;
  /**
   * Trim surrounding whitespace from UNQUOTED field values. Defaults to false.
   * Quoted content is never trimmed: the quotes are an explicit statement that
   * the bytes between them are the value, padding included.
   */
  readonly trimWhitespace?: boolean;
}

/** A structural defect in the CSV itself. `line` and `column` are 1-based. */
export class CsvParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'CsvParseError';
    this.line = line;
    this.column = column;
  }
}

interface CsvRecord {
  /** Physical line on which the record starts. A quoted newline may extend it. */
  readonly line: number;
  readonly fields: string[];
}

type State = 'FIELD_START' | 'UNQUOTED' | 'QUOTED' | 'AFTER_QUOTE';

interface ResolvedOptions {
  readonly delimiter: string;
  readonly trimWhitespace: boolean;
}

function resolveOptions(options: CsvOptions | undefined): ResolvedOptions {
  const delimiter = options?.delimiter ?? ',';
  if (delimiter.length !== 1) {
    throw new RangeError(
      `CSV delimiter must be exactly one character, got ${JSON.stringify(delimiter)}`,
    );
  }
  if (delimiter === QUOTE || delimiter === CR || delimiter === LF) {
    throw new RangeError(
      `CSV delimiter may not be a quote or a line ending, got ${JSON.stringify(delimiter)}`,
    );
  }
  return { delimiter, trimWhitespace: options?.trimWhitespace ?? false };
}

function parseRecords(text: string, options: CsvOptions | undefined): CsvRecord[] {
  const { delimiter, trimWhitespace } = resolveOptions(options);
  // Excel writes a BOM on every CSV export; left in place it becomes part of the
  // first header name and every lookup against that column silently misses.
  const src = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let buf = '';
  let state: State = 'FIELD_START';
  let fieldWasQuoted = false;
  let line = 1;
  let column = 1;
  let recordLine = 1;
  let quoteLine = 1;
  let quoteColumn = 1;
  /** False when nothing has been consumed since the last record ended. */
  let recordStarted = false;

  const endField = (): void => {
    fields.push(trimWhitespace && !fieldWasQuoted ? buf.trim() : buf);
    buf = '';
    fieldWasQuoted = false;
  };

  const endRecord = (): void => {
    records.push({ line: recordLine, fields });
    fields = [];
    recordStarted = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    const isCr = c === CR;
    const isTerminator = isCr || c === LF;

    if (!recordStarted) {
      recordLine = line;
      recordStarted = true;
    }

    switch (state) {
      case 'FIELD_START':
        if (c === QUOTE) {
          fieldWasQuoted = true;
          quoteLine = line;
          quoteColumn = column;
          state = 'QUOTED';
        } else if (c === delimiter) {
          endField();
        } else if (isTerminator) {
          endField();
          endRecord();
        } else {
          buf += c;
          state = 'UNQUOTED';
        }
        break;

      case 'UNQUOTED':
        if (c === QUOTE) {
          throw new CsvParseError(
            'unescaped double quote inside an unquoted field: quote the whole field and double any literal quote',
            line,
            column,
          );
        } else if (c === delimiter) {
          endField();
          state = 'FIELD_START';
        } else if (isTerminator) {
          endField();
          endRecord();
          state = 'FIELD_START';
        } else {
          buf += c;
        }
        break;

      case 'QUOTED':
        if (c === QUOTE) {
          state = 'AFTER_QUOTE';
        } else if (isTerminator) {
          // Normalize CRLF and lone CR to LF inside quoted values. The same
          // statement re-sent from a different system must produce byte-identical
          // fields, or its source hash changes and re-ingestion duplicates it.
          buf += LF;
        } else {
          buf += c;
        }
        break;

      case 'AFTER_QUOTE':
        if (c === QUOTE) {
          buf += QUOTE;
          state = 'QUOTED';
        } else if (c === delimiter) {
          endField();
          state = 'FIELD_START';
        } else if (isTerminator) {
          endField();
          endRecord();
          state = 'FIELD_START';
        } else {
          throw new CsvParseError(
            'text after a closing double quote: a quoted field must end at the delimiter or line ending',
            line,
            column,
          );
        }
        break;
    }

    if (isTerminator) {
      if (isCr && src.charAt(i + 1) === LF) i++;
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  if (state === 'QUOTED') {
    throw new CsvParseError(
      'unterminated quoted field: the quote opened here is never closed',
      quoteLine,
      quoteColumn,
    );
  }

  // A line ending at EOF terminates the final record rather than starting an
  // empty one. A blank line anywhere else is a real (empty) record and is kept:
  // dropping it would hide a hole in a statement.
  if (recordStarted) {
    endField();
    endRecord();
  }

  return records;
}

/**
 * Parse into raw rows. Rows are returned exactly as found, including ragged
 * ones; use `parseCsvTable` when the field count must be validated.
 */
export function parseCsv(text: string, options?: CsvOptions): string[][] {
  return parseRecords(text, options).map((record) => record.fields);
}

export interface CsvRow {
  /** Physical line on which this row starts, for error messages. */
  readonly lineNumber: number;
  readonly raw: readonly string[];
  /** Throws `RangeError` if `header` is not a column of this table. */
  get(header: string): string;
  has(header: string): boolean;
}

export interface CsvTable {
  /** Header names with surrounding whitespace removed, original case kept. */
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
}

/** `toLowerCase`, not `toLocaleLowerCase`: column matching must not vary by host locale. */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function makeRow(record: CsvRecord, index: ReadonlyMap<string, number>): CsvRow {
  const raw = record.fields;
  return {
    lineNumber: record.line,
    raw,
    has(header: string): boolean {
      return index.has(normalizeHeader(header));
    },
    get(header: string): string {
      const at = index.get(normalizeHeader(header));
      if (at === undefined) {
        throw new RangeError(
          `unknown CSV column ${JSON.stringify(header)}; available: ${[...index.keys()].join(', ')}`,
        );
      }
      // Safe: parseCsvTable rejected any record whose length differs from the header.
      return raw[at]!;
    },
  };
}

/**
 * Parse into a header-indexed table.
 *
 * Throws on a ragged row instead of padding or truncating it. In a financial
 * statement a short row means a column is misaligned, and inferring which one is
 * missing would put a market value into the maturity column.
 */
export function parseCsvTable(text: string, options?: CsvOptions): CsvTable {
  const records = parseRecords(text, options);
  const headerRecord = records[0];
  if (headerRecord === undefined) {
    throw new CsvParseError('empty CSV: expected at least a header line', 1, 1);
  }

  const headers = headerRecord.fields.map((name) => name.trim());
  const index = new Map<string, number>();
  for (const [position, name] of headers.entries()) {
    const key = normalizeHeader(name);
    const existing = index.get(key);
    if (existing !== undefined) {
      throw new CsvParseError(
        `duplicate header ${JSON.stringify(name)} at columns ${existing + 1} and ${position + 1}: lookup by name would be ambiguous`,
        headerRecord.line,
        1,
      );
    }
    index.set(key, position);
  }

  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const record = records[r]!;
    if (record.fields.length !== headers.length) {
      throw new CsvParseError(
        `expected ${headers.length} fields but found ${record.fields.length}: a ragged row means a misaligned column`,
        record.line,
        1,
      );
    }
    rows.push(makeRow(record, index));
  }

  return { headers, rows };
}
