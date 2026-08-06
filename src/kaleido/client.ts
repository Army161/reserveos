/**
 * The Kaleido integration boundary.
 *
 * Every call into the platform goes through this interface. Two reasons:
 *
 *  1. Testability. The whole application is exercisable without credentials or a
 *     live environment, which matters because the provisioning spike is week 1
 *     and domain work cannot wait on it.
 *  2. Concentration risk. `plan.md` flags building on a single vendor. The
 *     mitigation is real only if the coupling is confined to one seam — the
 *     underlying components (FireFly, Besu, Paladin) are open source and
 *     self-hostable, so a second implementation of this interface is the entire
 *     cost of moving off managed Kaleido.
 */

export type AnchorSubjectType = 'DAILY_ROLLUP' | 'REPORT_VERSION' | 'APPROVAL';

/** Contract enum ordinals. Must match `EvidenceAnchor.SubjectType`. */
export const ANCHOR_SUBJECT_ORDINAL: Record<AnchorSubjectType, number> = {
  DAILY_ROLLUP: 0,
  REPORT_VERSION: 1,
  APPROVAL: 2,
};

export interface AnchorRequest {
  /** 64-char lowercase hex, no 0x prefix. */
  readonly merkleRoot: string;
  readonly subjectType: AnchorSubjectType;
  /** Off-chain record UUID. */
  readonly subjectId: string;
  /** Unix day of period end, or 0 when not period-scoped. */
  readonly periodEnd: number;
}

/**
 * Submission is asynchronous. Kaleido's Transaction Manager owns nonce
 * allocation, gas, retry and confirmation, so we get an operation id back
 * immediately and learn the outcome from an event.
 */
export interface AnchorSubmission {
  readonly operationId: string;
}

export interface AnchorReceipt {
  readonly operationId: string;
  readonly status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  readonly transactionHash?: string;
  readonly blockNumber?: bigint;
  readonly error?: string;
}

export interface TokenSupplyQuery {
  readonly connectorId: string;
  readonly contractAddress: string;
}

export interface TokenSupplyResult {
  readonly totalSupply: bigint;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
}

/** A `Transfer` to or from the zero address, i.e. a mint or a burn. */
export interface SupplyEvent {
  readonly contractAddress: string;
  readonly kind: 'MINT' | 'BURN';
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  readonly transactionHash: string;
}

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly decisionId: string;
  readonly reason?: string;
}

export interface PolicyRequest {
  readonly policy: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface KaleidoClient {
  /** Append a commitment to the EvidenceAnchor contract via TMS. */
  submitAnchor(request: AnchorRequest): Promise<AnchorSubmission>;

  /** Poll an operation. In production, confirmation also arrives by event. */
  getAnchorReceipt(operationId: string): Promise<AnchorReceipt>;

  /** Read `totalSupply()` through an EVM connector. */
  getTokenSupply(query: TokenSupplyQuery): Promise<TokenSupplyResult>;

  /** Evaluate an OPA policy in the Policy Manager service. */
  evaluatePolicy(request: PolicyRequest): Promise<PolicyEvaluation>;

  /** Latest public-Ethereum state proof reference, from the Tether service. */
  getLatestTetherProof(): Promise<string | null>;
}

/** Encode a UUID as a bytes32 hex string for `subjectRef`. */
export function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError(`not a UUID: ${uuid}`);
  }
  return `0x${hex.toLowerCase().padStart(64, '0')}`;
}
