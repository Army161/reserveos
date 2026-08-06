import { merkleRoot } from '../domain/canonical.js';
import type { AnchorSubjectType, KaleidoClient } from '../kaleido/client.js';

/**
 * Evidence anchoring.
 *
 * Anchors are idempotent by (subjectType, subjectId) and are never assumed to
 * have succeeded. A submission that throws leaves a PENDING record for the
 * retry sweep; a submission that already exists on-chain is reconciled rather
 * than duplicated.
 */

export interface AnchorRecord {
  id: string;
  issuerId: string;
  subjectType: AnchorSubjectType;
  subjectId: string;
  merkleRoot: string;
  operationId: string | null;
  transactionHash: string | null;
  blockNumber: bigint | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  attempts: number;
  lastError: string | null;
}

/** Minimal persistence surface, so this is testable without a database. */
export interface AnchorStore {
  find(subjectType: AnchorSubjectType, subjectId: string): Promise<AnchorRecord | null>;
  insert(record: AnchorRecord): Promise<void>;
  update(record: AnchorRecord): Promise<void>;
  listPending(): Promise<AnchorRecord[]>;
}

export class InMemoryAnchorStore implements AnchorStore {
  private readonly records = new Map<string, AnchorRecord>();

  private key(subjectType: AnchorSubjectType, subjectId: string): string {
    return `${subjectType}:${subjectId}`;
  }

  async find(subjectType: AnchorSubjectType, subjectId: string): Promise<AnchorRecord | null> {
    return this.records.get(this.key(subjectType, subjectId)) ?? null;
  }

  async insert(record: AnchorRecord): Promise<void> {
    const key = this.key(record.subjectType, record.subjectId);
    if (this.records.has(key)) throw new Error(`duplicate anchor ${key}`);
    this.records.set(key, { ...record });
  }

  async update(record: AnchorRecord): Promise<void> {
    const key = this.key(record.subjectType, record.subjectId);
    // CONFIRMED is terminal, matching PgAnchorStore. A commitment that is on
    // chain cannot become un-anchored, and keeping the two stores in step means
    // the in-memory one stays a faithful stand-in for tests.
    if (this.records.get(key)?.status === 'CONFIRMED') return;
    this.records.set(key, { ...record });
  }

  async listPending(): Promise<AnchorRecord[]> {
    return [...this.records.values()].filter((r) => r.status === 'PENDING');
  }

  async all(): Promise<AnchorRecord[]> {
    return [...this.records.values()];
  }
}

export interface EvidenceServiceOptions {
  readonly store: AnchorStore;
  readonly kaleido: KaleidoClient;
  /** Injected so tests and replays are deterministic. */
  readonly newId: () => string;
}

export class EvidenceService {
  constructor(private readonly options: EvidenceServiceOptions) {}

  /**
   * Anchor a subject, or return the existing record if it is already anchored.
   *
   * Safe to call repeatedly: the retry sweep and the happy path share this code.
   */
  async anchor(params: {
    issuerId: string;
    subjectType: AnchorSubjectType;
    subjectId: string;
    merkleRoot: string;
    periodEnd?: Date;
  }): Promise<AnchorRecord> {
    const existing = await this.options.store.find(params.subjectType, params.subjectId);
    if (existing !== null && existing.status === 'CONFIRMED') return existing;

    const record: AnchorRecord = existing ?? {
      id: this.options.newId(),
      issuerId: params.issuerId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      merkleRoot: params.merkleRoot,
      operationId: null,
      transactionHash: null,
      blockNumber: null,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
    };

    if (existing === null) await this.options.store.insert(record);

    record.attempts += 1;

    try {
      const submission = await this.options.kaleido.submitAnchor({
        merkleRoot: params.merkleRoot,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        periodEnd: params.periodEnd === undefined ? 0 : unixDay(params.periodEnd),
      });
      record.operationId = submission.operationId;
      record.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // The contract already holds this commitment — a previous attempt landed
      // and we lost the response. That is success, not failure.
      if (message.startsWith('AlreadyAnchored')) {
        record.status = 'CONFIRMED';
        record.lastError = null;
        await this.options.store.update(record);
        return record;
      }

      record.status = 'PENDING';
      record.lastError = message;
      await this.options.store.update(record);
      return record;
    }

    await this.options.store.update(record);
    return this.refresh(record);
  }

  /** Pull the latest receipt for a pending anchor and persist any transition. */
  async refresh(record: AnchorRecord): Promise<AnchorRecord> {
    if (record.operationId === null) return record;

    const receipt = await this.options.kaleido.getAnchorReceipt(record.operationId);
    if (receipt.status === 'CONFIRMED') {
      record.status = 'CONFIRMED';
      record.transactionHash = receipt.transactionHash ?? null;
      record.blockNumber = receipt.blockNumber ?? null;
      record.lastError = null;
    } else if (receipt.status === 'FAILED') {
      // Stay PENDING so the sweep retries. FAILED is reserved for a permanent
      // condition an operator has triaged; a failed receipt is usually transient.
      record.status = 'PENDING';
      record.lastError = receipt.error ?? 'submission failed';
    }

    await this.options.store.update(record);
    return record;
  }

  /** Re-drive every pending anchor. Run on a schedule. */
  async sweepPending(): Promise<AnchorRecord[]> {
    const pending = await this.options.store.listPending();
    const results: AnchorRecord[] = [];

    for (const record of pending) {
      if (record.operationId === null) {
        results.push(
          await this.anchor({
            issuerId: record.issuerId,
            subjectType: record.subjectType,
            subjectId: record.subjectId,
            merkleRoot: record.merkleRoot,
          }),
        );
      } else {
        results.push(await this.refresh(record));
      }
    }

    return results;
  }

  /**
   * Anchor a day's ingested facts as a single Merkle commitment.
   *
   * Daily rollups are what make a figure provably pre-existing rather than
   * asserted after the fact at period close.
   */
  async anchorDailyRollup(params: {
    issuerId: string;
    rollupId: string;
    factHashes: readonly string[];
  }): Promise<AnchorRecord> {
    return this.anchor({
      issuerId: params.issuerId,
      subjectType: 'DAILY_ROLLUP',
      subjectId: params.rollupId,
      merkleRoot: merkleRoot(params.factHashes),
    });
  }
}

/** Whole days since the Unix epoch, UTC. */
export function unixDay(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}
