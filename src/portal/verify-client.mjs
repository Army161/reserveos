/**
 * Independent verification, run in the examiner's browser.
 *
 * This file is shipped to the browser as-is and is ALSO loaded directly by
 * `test/portal/verify-client.test.ts`, which checks it against the server's
 * TypeScript implementation over a large set of generated payloads. One
 * implementation, two consumers: a browser reimplementation that quietly drifted
 * from the server would produce a different hash for an identical document and
 * make honest reports look forged.
 *
 * Plain JavaScript with no build step and no dependencies, so an examiner can
 * read exactly what their browser executed.
 */

/**
 * RFC 8785 canonical JSON over a value space that excludes JSON numbers.
 *
 * Numbers are rejected rather than serialized. Number canonicalization is the
 * one part of RFC 8785 where implementations can disagree, and a disagreement
 * here would break verification for a correct report. Every quantity in a
 * ReserveOS payload is already a decimal string for this reason.
 */
export function canonicalize(value, path = '') {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'number') {
    throw new Error(
      `JSON numbers are not permitted in a canonical payload (at ${path || '<root>'})`,
    );
  }
  if (type === 'bigint' || type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new Error(`unsupported type ${type} at ${path || '<root>'}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => canonicalize(item, `${path}[${i}]`)).join(',')}]`;
  }

  // Mirrors the server's Date rejection literally, including the fact that it
  // rejects only Date. Any other exotic object serializes to its own enumerable
  // keys on both sides. Left out, a Date became `{}` here while the server
  // raised — a disagreement about a document one of the two would never emit.
  if (value instanceof Date) {
    throw new Error(
      `Date must be formatted as an ISO-8601 string before serialization (at ${path || '<root>'})`,
    );
  }

  // Sorting with the default comparator orders by UTF-16 code unit, which is
  // what JCS specifies for member ordering.
  const keys = Object.keys(value).sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(value[key], path ? `${path}.${key}` : key)}`,
  );
  return `{${members.join(',')}}`;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

export function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`not lowercase hex: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  return toHex(await crypto.subtle.digest('SHA-256', encoded));
}

/** SHA-256 of raw bytes, lowercase hex. */
export async function sha256Bytes(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** Canonicalize then hash, matching the server's `canonicalHash`. */
export async function canonicalHash(value) {
  return sha256Hex(canonicalize(value));
}

/**
 * The two-leaf commitment the ledger holds.
 *
 * Equivalent to the server's `merkleRoot([a, b])`: SHA-256 over the concatenated
 * raw bytes of the two digests, in order.
 */
export async function commitmentOf(reportHash, disclosureHash) {
  const left = hexToBytes(reportHash);
  const right = hexToBytes(disclosureHash);
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return sha256Bytes(joined);
}

/**
 * Verify a `/verify/:hash` response against the hash the examiner asked about.
 *
 * `requestedHash` is not optional and not a convenience. Every other check in
 * here compares one field of the response against another field of the same
 * response, and the server chose all of them together: it can serve a wholly
 * invented disclosure, hash it, derive a commitment from that hash, and report
 * that commitment as the anchored root. All of it is internally consistent. The
 * hash the examiner read off the signed report is the only value in this
 * function that the server did not supply, so it is the only thing that makes
 * the rest of the checks mean anything.
 *
 * The remaining gap after that is whether the anchoring transaction is really on
 * the ledger carrying this commitment. That cannot be settled in a browser, so
 * it is reported as an action for the examiner rather than a check that passed.
 */
export async function verifyResponse(response, requestedHash) {
  const checks = [];

  const asked = typeof requestedHash === 'string' ? requestedHash.trim().toLowerCase() : null;
  checks.push({
    id: 'requested-hash',
    label: 'This is an answer about the report you asked about',
    passed:
      asked !== null &&
      (asked === response.certifiedReportHash || asked === response.disclosureHash),
    expected: asked ?? '(no hash supplied)',
    actual: response.certifiedReportHash ?? '(absent)',
    explanation:
      'Every other check below compares the response against itself, so a server that invented the whole document would pass them all. Only the hash you brought with you ties this to the report you were given.',
  });

  const recomputedDisclosureHash = await canonicalHash(response.disclosure);
  checks.push({
    id: 'disclosure-hash',
    label: 'The published figures hash to the value served with them',
    passed: recomputedDisclosureHash === response.disclosureHash,
    expected: response.disclosureHash,
    actual: recomputedDisclosureHash,
    explanation:
      'Confirms the disclosure has not been altered since it was hashed. Any changed digit changes this value.',
  });

  const canonicalJson = canonicalize(response.disclosure);
  checks.push({
    id: 'canonical-json',
    label: 'Our canonical form matches the one the server published',
    passed: canonicalJson === response.canonicalJson,
    expected: response.canonicalJson,
    actual: canonicalJson,
    explanation:
      'Confirms the serialization rules agree. If these differ, the hashes above would differ for an honest report.',
  });

  const linkedReportHash = response.disclosure?.certifiedReportHash;
  checks.push({
    id: 'report-link',
    label: 'The disclosure names the certified report it came from',
    passed: linkedReportHash === response.certifiedReportHash,
    expected: response.certifiedReportHash,
    actual: linkedReportHash ?? '(absent)',
    explanation:
      'The full report stays private, but the disclosure must state which report it was derived from.',
  });

  // `disclosureHash` covers `disclosure` and nothing else. The `period` block
  // sits outside it, and it is the block the page prints as a heading — so
  // without this check a server can serve one month's genuine, correctly
  // anchored figures under another month's dates and every hash below still
  // agrees, because none of them reach this far.
  const servedPeriod = response.period ?? {};
  const hashedStart = response.disclosure?.period?.start;
  const hashedEnd = response.disclosure?.period?.end;
  const hashedGeneratedAt = response.disclosure?.generatedAt;
  const describe = (start, end, generatedAt) => `${start} to ${end}, generated ${generatedAt}`;
  checks.push({
    id: 'period-label',
    label: 'The period this is presented as covering is the one inside the hash',
    passed:
      typeof hashedStart === 'string' &&
      typeof hashedEnd === 'string' &&
      typeof hashedGeneratedAt === 'string' &&
      servedPeriod.start === hashedStart &&
      servedPeriod.end === hashedEnd &&
      servedPeriod.generatedAt === hashedGeneratedAt,
    expected: describe(hashedStart, hashedEnd, hashedGeneratedAt),
    actual: describe(servedPeriod.start, servedPeriod.end, servedPeriod.generatedAt),
    explanation:
      'Only the figures in `disclosure` are covered by the hashes. The dates printed around them are not, so they are compared against the dates that are.',
  });

  const commitment = await commitmentOf(response.certifiedReportHash, recomputedDisclosureHash);
  checks.push({
    id: 'commitment',
    label: 'Report and disclosure combine to the stated commitment',
    passed: commitment === response.commitment?.expected,
    expected: response.commitment?.expected,
    actual: commitment,
    explanation:
      'The ledger commits to both documents at once, so the published figures cannot be swapped for different ones citing the same report.',
  });

  const anchor = response.anchor;
  checks.push({
    id: 'anchor-match',
    label: 'The commitment matches what was written to the ledger',
    passed: anchor != null && anchor.merkleRoot === commitment,
    expected: commitment,
    actual: anchor?.merkleRoot ?? '(not anchored)',
    explanation:
      'Ties the figures you are reading to a specific ledger entry.',
  });

  // An anchor row is created with its root before the transaction confirms, and
  // a report can be published while that submission is still pending or has
  // failed. Without this check such a report passed everything above and then
  // silently omitted the ledger step, because there was no transaction to name.
  const transactionHash = typeof anchor?.transactionHash === 'string' ? anchor.transactionHash : null;
  checks.push({
    id: 'anchor-confirmed',
    label: 'That ledger entry was actually accepted on chain',
    passed: anchor?.status === 'CONFIRMED' && transactionHash !== null && transactionHash !== '',
    expected: 'CONFIRMED, naming a transaction',
    actual:
      anchor == null
        ? '(not anchored)'
        : `${anchor.status ?? '(no status)'}, transaction ${transactionHash ?? '(none)'}`,
    explanation:
      'A commitment that was submitted but never confirmed binds nothing. Until this passes there is no transaction for you to look up, and the figures above rest on this server alone.',
  });

  const allPassed = checks.every((check) => check.passed);

  return {
    checks,
    allPassed,
    /**
     * Deliberately not a check: only the examiner can settle this. Withheld
     * unless every check above passed.
     *
     * On a relabelled period the figures, the hashes and the anchor are all
     * genuine and only the dates printed around them are wrong, so
     * `anchor-match` and `anchor-confirmed` still pass and the commitment this
     * step would hand over is the one really on chain. Offering the instruction
     * beside a failed verdict therefore walks the examiner through a LEDGER
     * LOOKUP THAT SUCCEEDS for a document this page has just refused — and the
     * instructions name that lookup as the decisive step. A run that failed has
     * nothing for the examiner to confirm.
     */
    independentStep:
      !allPassed || transactionHash === null
        ? null
        : {
            transactionHash,
            blockNumber: anchor.blockNumber,
            anchoredAt: anchor.anchoredAt,
            /** Carried here so the examiner has the value to compare on chain. */
            commitment,
            instruction:
              'Look this transaction up on the ledger yourself and confirm it carries the commitment shown here. This page cannot prove it to you, and nothing above is evidence that it happened.',
          },
  };
}
