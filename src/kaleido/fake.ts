import type {
  AnchorReceipt,
  AnchorRequest,
  AnchorSubmission,
  KaleidoClient,
  PolicyEvaluation,
  PolicyRequest,
  TokenSupplyQuery,
  TokenSupplyResult,
} from './client.js';

/**
 * In-memory KaleidoClient for tests and local development.
 *
 * Mirrors the real platform's semantics that actually affect our correctness:
 * asynchronous confirmation, and the on-chain duplicate-subject rejection. It
 * can also be told to fail, so recovery paths are exercised rather than assumed.
 */
export class FakeKaleidoClient implements KaleidoClient {
  private readonly commitments = new Map<string, AnchorRequest>();
  private readonly operations = new Map<string, AnchorReceipt>();
  private readonly supplies = new Map<string, TokenSupplyResult>();
  private policyAllows = true;
  private policyReason: string | undefined;
  private nextFailure: string | null = null;
  private blockNumber = 1_000n;
  private sequence = 0;

  /** Confirm operations immediately instead of leaving them pending. */
  autoConfirm = true;

  // --- test controls ----------------------------------------------------

  setSupply(contractAddress: string, result: TokenSupplyResult): void {
    this.supplies.set(contractAddress.toLowerCase(), result);
  }

  setPolicy(allowed: boolean, reason?: string): void {
    this.policyAllows = allowed;
    this.policyReason = reason;
  }

  /** Make the next `submitAnchor` call reject, to exercise retry handling. */
  failNextSubmission(message: string): void {
    this.nextFailure = message;
  }

  confirm(operationId: string): void {
    const existing = this.operations.get(operationId);
    if (existing === undefined) throw new Error(`unknown operation ${operationId}`);
    this.blockNumber += 1n;
    this.operations.set(operationId, {
      operationId,
      status: 'CONFIRMED',
      transactionHash: `0x${operationId.padStart(64, '0')}`,
      blockNumber: this.blockNumber,
    });
  }

  get anchorCount(): number {
    return this.commitments.size;
  }

  // --- KaleidoClient ----------------------------------------------------

  async submitAnchor(request: AnchorRequest): Promise<AnchorSubmission> {
    if (this.nextFailure !== null) {
      const message = this.nextFailure;
      this.nextFailure = null;
      throw new Error(message);
    }

    const key = `${request.subjectType}:${request.subjectId}`;
    if (this.commitments.has(key)) {
      // The contract reverts with AlreadyAnchored; surfacing it the same way
      // keeps the retry path honest.
      throw new Error(`AlreadyAnchored: ${key}`);
    }
    if (/^0+$/.test(request.merkleRoot)) {
      throw new Error('ZeroRoot');
    }

    this.commitments.set(key, request);
    this.sequence += 1;
    const operationId = `op-${this.sequence}`;

    this.operations.set(operationId, { operationId, status: 'PENDING' });
    if (this.autoConfirm) this.confirm(operationId);

    return { operationId };
  }

  async getAnchorReceipt(operationId: string): Promise<AnchorReceipt> {
    return (
      this.operations.get(operationId) ?? {
        operationId,
        status: 'FAILED',
        error: 'unknown operation',
      }
    );
  }

  async getTokenSupply(query: TokenSupplyQuery): Promise<TokenSupplyResult> {
    const result = this.supplies.get(query.contractAddress.toLowerCase());
    if (result === undefined) {
      throw new Error(`no supply configured for ${query.contractAddress}`);
    }
    return result;
  }

  async evaluatePolicy(request: PolicyRequest): Promise<PolicyEvaluation> {
    this.sequence += 1;
    return {
      allowed: this.policyAllows,
      decisionId: `pms-${this.sequence}-${request.policy}`,
      ...(this.policyReason === undefined ? {} : { reason: this.policyReason }),
    };
  }

  async getLatestTetherProof(): Promise<string | null> {
    return this.commitments.size === 0 ? null : `tether-proof-${this.commitments.size}`;
  }
}
