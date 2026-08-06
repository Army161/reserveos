/**
 * Types for the operator console's DOM and formatting helpers.
 *
 * The implementation is plain JavaScript because it is served straight to the
 * browser with no build step, matching the examiner portal.
 */

export function el(
  tag: string,
  props?: Record<string, unknown>,
  ...children: unknown[]
): HTMLElement;

export function clear<T extends Element>(node: T): T;

/** Group thousands in a decimal string without parsing it as a number. */
export function groupDigits(decimal: string): string;
export function usd(decimal: string | null | undefined): string;
export function percent(decimal: string | null | undefined): string;
/** Shift a ratio string two decimal places right: '1.0500' becomes '105.00%'. */
export function ratioToPercent(ratio: string | null | undefined): string;
/** Tone for a collateralization ratio, chosen by string comparison. */
export function collateralTone(
  ratio: string | null | undefined,
): 'good' | 'warn' | 'bad' | 'neutral';
export function shortHash(hash: string | null | undefined): string;
export function formatDateTime(iso: string | null | undefined): string;

export function statusBadge(status: string): HTMLElement;
export function severityBadge(severity: string): HTMLElement;
export function table(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  options?: { numericColumns?: readonly number[] },
): HTMLElement;
export function emptyState(message: string): HTMLElement;
export function panel(title: string, ...children: unknown[]): HTMLElement;
