import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  canonicalize,
  merkleRoot,
  NonCanonicalValueError,
} from '../src/domain/canonical.js';

describe('canonicalize', () => {
  it('sorts object keys by UTF-16 code unit', () => {
    expect(canonicalize({ b: '2', a: '1', C: '3' })).toBe('{"C":"3","a":"1","b":"2"}');
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ z: { y: '1', x: '2' } })).toBe('{"z":{"x":"2","y":"1"}}');
  });

  it('produces identical output regardless of key insertion order', () => {
    const a = { alpha: '1', beta: { gamma: 'x', delta: 'y' } };
    const b = { beta: { delta: 'y', gamma: 'x' }, alpha: '1' };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves array order', () => {
    expect(canonicalize(['c', 'a', 'b'])).toBe('["c","a","b"]');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: ['1', '2'] })).toBe('{"a":["1","2"]}');
  });

  it('rejects JSON numbers, which is the whole point of the restriction', () => {
    // @ts-expect-error deliberately passing a forbidden type
    expect(() => canonicalize({ amount: 1.1 })).toThrow(NonCanonicalValueError);
  });

  it('rejects bigint and Date, which have no unambiguous JSON form', () => {
    // @ts-expect-error deliberately passing a forbidden type
    expect(() => canonicalize({ n: 1n })).toThrow(NonCanonicalValueError);
    // @ts-expect-error deliberately passing a forbidden type
    expect(() => canonicalize({ d: new Date() })).toThrow(NonCanonicalValueError);
  });

  it('names the offending path so the error is actionable', () => {
    // @ts-expect-error deliberately passing a forbidden type
    expect(() => canonicalize({ reserves: { total: 5 } })).toThrow(/reserves\.total/);
  });

  it('escapes strings per JSON rules', () => {
    expect(canonicalize({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
  });

  it('handles null and booleans', () => {
    expect(canonicalize({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });
});

describe('canonicalHash', () => {
  it('is stable and order-independent', () => {
    expect(canonicalHash({ a: '1', b: '2' })).toBe(canonicalHash({ b: '2', a: '1' }));
  });

  it('changes when any byte of content changes', () => {
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: '2' }));
  });

  it('returns lowercase hex of the expected length', () => {
    expect(canonicalHash({ a: '1' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('merkleRoot', () => {
  const h = (n: number) => n.toString(16).padStart(64, '0');

  it('returns the zero hash for an empty set', () => {
    expect(merkleRoot([])).toBe('0'.repeat(64));
  });

  it('returns the single leaf unchanged', () => {
    expect(merkleRoot([h(1)])).toBe(h(1));
  });

  it('is order-sensitive, so reordering facts is detectable', () => {
    expect(merkleRoot([h(1), h(2)])).not.toBe(merkleRoot([h(2), h(1)]));
  });

  it('is deterministic across calls', () => {
    const leaves = [h(1), h(2), h(3), h(4), h(5)];
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it('changes when any leaf changes', () => {
    expect(merkleRoot([h(1), h(2), h(3)])).not.toBe(merkleRoot([h(1), h(2), h(4)]));
  });
});
