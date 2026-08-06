import { redemptionDeadline, type BusinessCalendar } from '../domain/calendar.js';

/**
 * Redemption SLA tracking.
 *
 * Escalates before a breach rather than reporting one afterwards. The monthly
 * summary produced here becomes part of the certified report pack.
 */

export type RedemptionStatus = 'RECEIVED' | 'PROCESSING' | 'SETTLED' | 'REJECTED' | 'BREACHED';

export interface RedemptionRequest {
  readonly id: string;
  readonly issuerId: string;
  readonly externalRef: string;
  readonly requestedAt: Date;
  readonly amountMinor: bigint;
  readonly slaDeadline: Date;
  readonly settledAt: Date | null;
  readonly status: RedemptionStatus;
}

export type SlaState = 'ON_TRACK' | 'WARNING' | 'ESCALATED' | 'BREACHED' | 'CLOSED';

/** Fractions of the SLA window at which to warn and escalate. */
const WARN_AT = 0.75;
const ESCALATE_AT = 0.9;

export function slaState(request: RedemptionRequest, now: Date): SlaState {
  if (request.status === 'SETTLED' || request.status === 'REJECTED') return 'CLOSED';
  if (now.getTime() > request.slaDeadline.getTime()) return 'BREACHED';

  const total = request.slaDeadline.getTime() - request.requestedAt.getTime();
  if (total <= 0) return 'ESCALATED';

  const elapsed = (now.getTime() - request.requestedAt.getTime()) / total;
  if (elapsed >= ESCALATE_AT) return 'ESCALATED';
  if (elapsed >= WARN_AT) return 'WARNING';
  return 'ON_TRACK';
}

export function openRequest(params: {
  id: string;
  issuerId: string;
  externalRef: string;
  requestedAt: Date;
  amountMinor: bigint;
  calendar: BusinessCalendar;
}): RedemptionRequest {
  if (params.amountMinor <= 0n) {
    throw new RangeError('redemption amount must be positive');
  }
  return {
    id: params.id,
    issuerId: params.issuerId,
    externalRef: params.externalRef,
    requestedAt: params.requestedAt,
    amountMinor: params.amountMinor,
    slaDeadline: redemptionDeadline(params.requestedAt, params.calendar),
    settledAt: null,
    status: 'RECEIVED',
  };
}

export function settle(request: RedemptionRequest, settledAt: Date): RedemptionRequest {
  if (request.status === 'SETTLED' || request.status === 'REJECTED') {
    throw new Error(`request ${request.externalRef} is already closed`);
  }
  // A late settlement is still recorded as BREACHED — the fact that it eventually
  // settled does not undo the missed deadline, and the examiner needs to see it.
  const breached = settledAt.getTime() > request.slaDeadline.getTime();
  return {
    ...request,
    settledAt,
    status: breached ? 'BREACHED' : 'SETTLED',
  };
}

export interface RedemptionSummary {
  readonly requestCount: number;
  readonly settledCount: number;
  readonly breachedCount: number;
  readonly medianSettlementMinutes: number | null;
}

/** Summarize a period's redemption activity for the report pack. */
export function summarize(requests: readonly RedemptionRequest[]): RedemptionSummary {
  const settledDurations: number[] = [];
  let settledCount = 0;
  let breachedCount = 0;

  for (const request of requests) {
    if (request.status === 'BREACHED') breachedCount += 1;
    if (request.settledAt !== null && request.status !== 'REJECTED') {
      settledCount += 1;
      settledDurations.push(
        Math.round((request.settledAt.getTime() - request.requestedAt.getTime()) / 60_000),
      );
    }
  }

  return {
    requestCount: requests.length,
    settledCount,
    breachedCount,
    medianSettlementMinutes: median(settledDurations),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Even counts round the midpoint to an integer so the summary stays exactly
  // reproducible — it is hashed as part of the report payload.
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
