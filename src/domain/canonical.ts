import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization and hashing for report payloads.
 *
 * This is an RFC 8785 (JCS) implementation over a deliberately restricted value
 * space: **JSON numbers are forbidden**. Every numeric quantity in a report
 * payload must already be a string.
 *
 * Why: the hardest and most error-prone part of RFC 8785 is serializing numbers
 * per ECMAScript `Number::toString`, and any disagreement there produces a
 * different hash for a logically identical document — which would silently break
 * independent verification, the one property the whole product rests on. Banning
 * numbers removes that entire class of failure, and costs nothing because all our
 * quantities are exact integers or fixed-precision decimals that must not pass
 * through IEEE-754 anyway.
 *
 * With numbers excluded, canonicalization reduces to two rules:
 *   1. Object keys sorted by UTF-16 code unit (JS default sort order).
 *   2. No insignificant whitespace.
 * String escaping from `JSON.stringify` already matches JCS.
 */

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class NonCanonicalValueError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || '<root>'}`);
    this.name = 'NonCanonicalValueError';
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);

    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      throw new NonCanonicalValueError(
        'JSON numbers are forbidden in canonical payloads; format as a string first',
        path,
      );

    case 'bigint':
      throw new NonCanonicalValueError(
        'bigint must be formatted as a string before serialization',
        path,
      );

    case 'undefined':
      throw new NonCanonicalValueError('undefined is not serializable', path);

    case 'object':
      break;

    default:
      throw new NonCanonicalValueError(`unsupported type ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) => serialize(item, `${path}[${i}]`));
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    throw new NonCanonicalValueError(
      'Date must be formatted as an ISO-8601 string before serialization',
      path,
    );
  }

  const record = value as Record<string, unknown>;
  // Array.prototype.sort compares UTF-16 code units, which is exactly what JCS
  // requires for member ordering.
  const keys = Object.keys(record).sort();
  const members = keys.map((key) => {
    const serialized = serialize(record[key], path ? `${path}.${key}` : key);
    return `${JSON.stringify(key)}:${serialized}`;
  });

  return `{${members.join(',')}}`;
}

/** Serialize a value to its canonical JSON form. Throws on any non-canonical input. */
export function canonicalize(value: CanonicalValue): string {
  return serialize(value, '');
}

/** SHA-256 of the canonical form, lowercase hex, no `0x` prefix. */
export function canonicalHash(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** SHA-256 of arbitrary bytes, lowercase hex. Used for raw source documents. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Merkle root over an ordered list of leaf hashes, for daily rollup anchoring.
 *
 * Duplicates the final node when a level has an odd count. That is the common
 * Bitcoin-style construction and is safe here because leaves are fixed-length
 * SHA-256 digests of distinct records, so the second-preimage ambiguity that
 * affects variable-length leaves does not arise.
 */
export function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) {
    return '0'.repeat(64);
  }

  let level = [...leafHashes];

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(
        createHash('sha256')
          .update(Buffer.from(left + right, 'hex'))
          .digest('hex'),
      );
    }
    level = next;
  }

  return level[0]!;
}
