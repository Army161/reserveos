import { beforeEach, describe, expect, it } from 'vitest';
import { FakeKaleidoClient } from '../src/kaleido/fake.js';
import { EvidenceService, InMemoryAnchorStore, unixDay } from '../src/services/evidence.js';
import { uuidToBytes32 } from '../src/kaleido/client.js';
import { merkleRoot } from '../src/domain/canonical.js';

const ISSUER_ID = '11111111-1111-1111-1111-111111111111';
const SUBJECT_ID = '55555555-5555-5555-5555-555555555555';
const ROOT = 'b'.repeat(64);

describe('EvidenceService', () => {
  let kaleido: FakeKaleidoClient;
  let store: InMemoryAnchorStore;
  let service: EvidenceService;
  let counter: number;

  beforeEach(() => {
    kaleido = new FakeKaleidoClient();
    store = new InMemoryAnchorStore();
    counter = 0;
    service = new EvidenceService({ store, kaleido, newId: () => `anchor-${++counter}` });
  });

  const anchor = (subjectId = SUBJECT_ID, root = ROOT) =>
    service.anchor({
      issuerId: ISSUER_ID,
      subjectType: 'REPORT_VERSION',
      subjectId,
      merkleRoot: root,
    });

  it('anchors and confirms', async () => {
    const record = await anchor();
    expect(record.status).toBe('CONFIRMED');
    expect(record.transactionHash).toMatch(/^0x/);
    expect(record.blockNumber).toBeGreaterThan(0n);
  });

  it('is idempotent: re-anchoring a confirmed subject does not submit again', async () => {
    await anchor();
    await anchor();
    await anchor();
    expect(kaleido.anchorCount).toBe(1);
  });

  it('leaves a pending record when submission throws, rather than losing the anchor', async () => {
    kaleido.failNextSubmission('connector unavailable');
    const record = await anchor();

    expect(record.status).toBe('PENDING');
    expect(record.lastError).toBe('connector unavailable');
    expect(record.attempts).toBe(1);
    expect(kaleido.anchorCount).toBe(0);
  });

  it('recovers a failed submission on the next sweep', async () => {
    kaleido.failNextSubmission('connector unavailable');
    await anchor();

    const [recovered] = await service.sweepPending();
    expect(recovered!.status).toBe('CONFIRMED');
    expect(recovered!.attempts).toBe(2);
    expect(kaleido.anchorCount).toBe(1);
  });

  it('treats an on-chain AlreadyAnchored revert as success, not failure', async () => {
    // Simulates the response being lost after the transaction actually landed.
    await kaleido.submitAnchor({
      merkleRoot: ROOT,
      subjectType: 'REPORT_VERSION',
      subjectId: SUBJECT_ID,
      periodEnd: 0,
    });

    const record = await anchor();
    expect(record.status).toBe('CONFIRMED');
    expect(kaleido.anchorCount).toBe(1);
  });

  it('stays pending when confirmation has not arrived yet', async () => {
    kaleido.autoConfirm = false;
    const record = await anchor();
    expect(record.status).toBe('PENDING');
    expect(record.operationId).not.toBeNull();

    kaleido.confirm(record.operationId!);
    const [swept] = await service.sweepPending();
    expect(swept!.status).toBe('CONFIRMED');
  });

  it('does not re-submit when only confirmation is outstanding', async () => {
    kaleido.autoConfirm = false;
    const record = await anchor();
    await service.sweepPending();
    await service.sweepPending();
    expect(kaleido.anchorCount).toBe(1);
    expect(record.attempts).toBe(1);
  });

  it('rejects an all-zero root, which would anchor nothing', async () => {
    const record = await anchor(SUBJECT_ID, '0'.repeat(64));
    expect(record.status).toBe('PENDING');
    expect(record.lastError).toBe('ZeroRoot');
  });

  it('anchors a daily rollup over the day\'s fact hashes', async () => {
    const hashes = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
    const record = await service.anchorDailyRollup({
      issuerId: ISSUER_ID,
      rollupId: SUBJECT_ID,
      factHashes: hashes,
    });
    expect(record.status).toBe('CONFIRMED');
    expect(record.merkleRoot).toBe(merkleRoot(hashes));
  });

  it('keeps anchors for different subjects separate', async () => {
    await anchor('55555555-5555-5555-5555-555555555555');
    await anchor('66666666-6666-6666-6666-666666666666');
    expect(kaleido.anchorCount).toBe(2);
  });
});

describe('uuidToBytes32', () => {
  it('encodes a UUID as left-padded bytes32', () => {
    expect(uuidToBytes32('11111111-1111-1111-1111-111111111111')).toBe(
      `0x${'0'.repeat(32)}${'1'.repeat(32)}`,
    );
  });

  it('rejects a non-UUID rather than silently producing a bad ref', () => {
    expect(() => uuidToBytes32('not-a-uuid')).toThrow(TypeError);
  });
});

describe('unixDay', () => {
  it('converts a date to whole days since the epoch', () => {
    expect(unixDay(new Date('1970-01-01T00:00:00Z'))).toBe(0);
    expect(unixDay(new Date('1970-01-02T23:59:59Z'))).toBe(1);
  });
});
