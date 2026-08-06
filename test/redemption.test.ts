import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  CalendarRangeError,
  isBusinessDay,
  redemptionDeadline,
  US_FEDERAL,
} from '../src/domain/calendar.js';
import {
  openRequest,
  settle,
  slaState,
  summarize,
  type RedemptionRequest,
} from '../src/services/redemption.js';

const ISSUER_ID = 'issuer-1';

describe('business calendar', () => {
  it('treats weekends as non-business days', () => {
    expect(isBusinessDay(new Date('2026-03-28T12:00:00Z'), US_FEDERAL)).toBe(false); // Saturday
    expect(isBusinessDay(new Date('2026-03-29T12:00:00Z'), US_FEDERAL)).toBe(false); // Sunday
    expect(isBusinessDay(new Date('2026-03-30T12:00:00Z'), US_FEDERAL)).toBe(true); // Monday
  });

  it('treats federal holidays as non-business days', () => {
    expect(isBusinessDay(new Date('2026-07-03T12:00:00Z'), US_FEDERAL)).toBe(false);
    expect(isBusinessDay(new Date('2026-11-26T12:00:00Z'), US_FEDERAL)).toBe(false);
  });

  it('skips weekends when adding business days', () => {
    // Thursday + 2 business days = Monday
    const result = addBusinessDays(new Date('2026-03-26T10:00:00Z'), 2, US_FEDERAL);
    expect(result.toISOString().slice(0, 10)).toBe('2026-03-30');
  });

  it('skips holidays when adding business days', () => {
    // Wed Jul 1 + 2 business days: Thu Jul 2, then Fri Jul 3 is the observed
    // Independence Day holiday, so the second business day is Mon Jul 6.
    const result = addBusinessDays(new Date('2026-07-01T10:00:00Z'), 2, US_FEDERAL);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-06');
  });

  it('refuses to extrapolate past the loaded holiday table', () => {
    expect(() => addBusinessDays(new Date('2028-12-28T10:00:00Z'), 10, US_FEDERAL)).toThrow(
      CalendarRangeError,
    );
  });

  it('rejects a negative or fractional day count', () => {
    expect(() => addBusinessDays(new Date('2026-03-02T10:00:00Z'), -1, US_FEDERAL)).toThrow(
      RangeError,
    );
    expect(() => addBusinessDays(new Date('2026-03-02T10:00:00Z'), 1.5, US_FEDERAL)).toThrow(
      RangeError,
    );
  });
});

describe('redemptionDeadline', () => {
  it('gives two full business days for a request inside the cutoff', () => {
    // Monday 10:00 UTC -> deadline end of Wednesday
    const deadline = redemptionDeadline(new Date('2026-03-02T10:00:00Z'), US_FEDERAL);
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-03-04');
  });

  it('rolls a post-cutoff request to the next business day before starting the clock', () => {
    // Monday 23:00 UTC is after the 22:00 cutoff -> received Tuesday -> Thursday
    const deadline = redemptionDeadline(new Date('2026-03-02T23:00:00Z'), US_FEDERAL);
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-03-05');
  });

  it('rolls a weekend request to Monday before starting the clock', () => {
    // Saturday -> received Monday -> deadline Wednesday
    const deadline = redemptionDeadline(new Date('2026-03-07T10:00:00Z'), US_FEDERAL);
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-03-11');
  });

  it('extends across a holiday', () => {
    // Thursday Jul 2 -> Fri Jul 3 is a holiday -> Mon Jul 6, Tue Jul 7
    const deadline = redemptionDeadline(new Date('2026-07-02T10:00:00Z'), US_FEDERAL);
    expect(deadline.toISOString().slice(0, 10)).toBe('2026-07-07');
  });

  it('ends at the last instant of the deadline day, not the first', () => {
    const deadline = redemptionDeadline(new Date('2026-03-02T10:00:00Z'), US_FEDERAL);
    expect(deadline.toISOString()).toBe('2026-03-04T23:59:59.999Z');
  });
});

describe('slaState', () => {
  const request = openRequest({
    id: 'r1',
    issuerId: ISSUER_ID,
    externalRef: 'REQ-1',
    requestedAt: new Date('2026-03-02T10:00:00Z'),
    amountMinor: 100_000n,
    calendar: US_FEDERAL,
  });

  it('is on track early in the window', () => {
    expect(slaState(request, new Date('2026-03-02T12:00:00Z'))).toBe('ON_TRACK');
  });

  it('warns at 75% elapsed', () => {
    // Window is 2026-03-02T10:00 -> 2026-03-04T23:59:59.999, ~62 hours.
    expect(slaState(request, new Date('2026-03-04T09:00:00Z'))).toBe('WARNING');
  });

  it('escalates at 90% elapsed', () => {
    expect(slaState(request, new Date('2026-03-04T19:00:00Z'))).toBe('ESCALATED');
  });

  it('breaches after the deadline', () => {
    expect(slaState(request, new Date('2026-03-05T00:30:00Z'))).toBe('BREACHED');
  });

  it('closes once settled', () => {
    const settled = settle(request, new Date('2026-03-03T10:00:00Z'));
    expect(slaState(settled, new Date('2026-03-09T00:00:00Z'))).toBe('CLOSED');
  });
});

describe('settle', () => {
  const request = openRequest({
    id: 'r1',
    issuerId: ISSUER_ID,
    externalRef: 'REQ-1',
    requestedAt: new Date('2026-03-02T10:00:00Z'),
    amountMinor: 100_000n,
    calendar: US_FEDERAL,
  });

  it('marks an in-time settlement as SETTLED', () => {
    expect(settle(request, new Date('2026-03-03T10:00:00Z')).status).toBe('SETTLED');
  });

  it('records a late settlement as BREACHED, since settling late does not undo the miss', () => {
    expect(settle(request, new Date('2026-03-06T10:00:00Z')).status).toBe('BREACHED');
  });

  it('refuses to settle a closed request twice', () => {
    const settled = settle(request, new Date('2026-03-03T10:00:00Z'));
    expect(() => settle(settled, new Date('2026-03-03T11:00:00Z'))).toThrow(/already closed/);
  });

  it('rejects a non-positive amount at intake', () => {
    expect(() =>
      openRequest({
        id: 'r2',
        issuerId: ISSUER_ID,
        externalRef: 'REQ-2',
        requestedAt: new Date('2026-03-02T10:00:00Z'),
        amountMinor: 0n,
        calendar: US_FEDERAL,
      }),
    ).toThrow(RangeError);
  });
});

describe('summarize', () => {
  const base = {
    issuerId: ISSUER_ID,
    requestedAt: new Date('2026-03-02T10:00:00Z'),
    slaDeadline: new Date('2026-03-04T23:59:59.999Z'),
  };

  const make = (
    id: string,
    status: RedemptionRequest['status'],
    settledMinutes: number | null,
  ): RedemptionRequest => ({
    ...base,
    id,
    externalRef: id,
    amountMinor: 1_000n,
    settledAt:
      settledMinutes === null ? null : new Date(base.requestedAt.getTime() + settledMinutes * 60_000),
    status,
  });

  it('counts requests, settlements and breaches', () => {
    const summary = summarize([
      make('a', 'SETTLED', 30),
      make('b', 'SETTLED', 90),
      make('c', 'BREACHED', 5_000),
      make('d', 'RECEIVED', null),
    ]);
    expect(summary.requestCount).toBe(4);
    expect(summary.settledCount).toBe(3);
    expect(summary.breachedCount).toBe(1);
  });

  it('computes an odd-count median', () => {
    const summary = summarize([
      make('a', 'SETTLED', 10),
      make('b', 'SETTLED', 30),
      make('c', 'SETTLED', 80),
    ]);
    expect(summary.medianSettlementMinutes).toBe(30);
  });

  it('computes an even-count median as an integer, so the report hash is stable', () => {
    const summary = summarize([make('a', 'SETTLED', 10), make('b', 'SETTLED', 15)]);
    expect(summary.medianSettlementMinutes).toBe(13);
    expect(Number.isInteger(summary.medianSettlementMinutes)).toBe(true);
  });

  it('returns null rather than NaN when nothing settled', () => {
    const summary = summarize([make('a', 'RECEIVED', null)]);
    expect(summary.medianSettlementMinutes).toBeNull();
  });

  it('handles an empty period', () => {
    expect(summarize([])).toEqual({
      requestCount: 0,
      settledCount: 0,
      breachedCount: 0,
      medianSettlementMinutes: null,
    });
  });
});
