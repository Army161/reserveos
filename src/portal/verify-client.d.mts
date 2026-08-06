/**
 * Types for the browser verification module.
 *
 * The implementation is plain JavaScript on purpose — it is served to the
 * examiner as readable source rather than a bundle — so its types live here.
 */

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalize(value: CanonicalValue, path?: string): string;
export function hexToBytes(hex: string): Uint8Array;
export function sha256Hex(text: string): Promise<string>;
export function sha256Bytes(bytes: Uint8Array): Promise<string>;
export function canonicalHash(value: CanonicalValue): Promise<string>;
export function commitmentOf(reportHash: string, disclosureHash: string): Promise<string>;

export interface VerificationCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly explanation: string;
}

export interface IndependentStep {
  readonly transactionHash: string;
  readonly blockNumber: string | null;
  readonly anchoredAt: string | null;
  /** The value the examiner must find on chain. */
  readonly commitment: string;
  readonly instruction: string;
}

export interface VerificationResult {
  readonly checks: readonly VerificationCheck[];
  readonly allPassed: boolean;
  readonly independentStep: IndependentStep | null;
}

/**
 * `requestedHash` is required. It is the only input not chosen by the server,
 * and without it the checks only establish that the response agrees with itself.
 */
export function verifyResponse(
  response: unknown,
  requestedHash: string,
): Promise<VerificationResult>;
