/**
 * Business-day arithmetic for the redemption SLA clock.
 *
 * The OCC proposed rule codifies a two-business-day redemption standard, so a
 * wrong holiday table produces false breach alerts. False alerts are worse than
 * useless here: the compliance team stops trusting the alerting, which defeats
 * the point of continuous monitoring.
 */

/** US federal holidays, observed dates, as ISO yyyy-mm-dd. */
const US_FEDERAL_HOLIDAYS_2026_2028: readonly string[] = [
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, Jul 4 is a Saturday)
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-05-31',
  '2027-06-18', // Juneteenth observed (Jun 19 is a Saturday)
  '2027-07-05', // Independence Day observed (Jul 4 is a Sunday)
  '2027-09-06',
  '2027-10-11',
  '2027-11-11',
  '2027-11-25',
  '2027-12-24', // Christmas observed (Dec 25 is a Saturday)
  // 2028
  '2028-01-17',
  '2028-02-21',
  '2028-05-29',
  '2028-06-19',
  '2028-07-04',
  '2028-09-04',
  '2028-10-09',
  '2028-11-10', // Veterans Day observed (Nov 11 is a Saturday)
  '2028-11-23',
  '2028-12-25',
];

export interface BusinessCalendar {
  readonly name: string;
  readonly holidays: ReadonlySet<string>;
  /** Cutoff hour (UTC) after which a request counts as received the next day. */
  readonly cutoffHourUtc: number;
}

export const US_FEDERAL: BusinessCalendar = {
  name: 'US_FEDERAL',
  holidays: new Set(US_FEDERAL_HOLIDAYS_2026_2028),
  cutoffHourUtc: 22, // 5pm ET
};

export const CALENDARS: ReadonlyMap<string, BusinessCalendar> = new Map([
  [US_FEDERAL.name, US_FEDERAL],
]);

/** Latest date covered by the holiday table, used to refuse silent extrapolation. */
const HOLIDAY_TABLE_END = '2028-12-31';

export class CalendarRangeError extends Error {
  constructor(iso: string) {
    super(
      `date ${iso} is beyond the loaded holiday table (through ${HOLIDAY_TABLE_END}); ` +
        'extend the calendar before computing SLA deadlines in this range',
    );
    this.name = 'CalendarRangeError';
  }
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isBusinessDay(date: Date, calendar: BusinessCalendar): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !calendar.holidays.has(toIsoDate(date));
}

/**
 * Add `count` business days to `from`.
 *
 * Throws rather than extrapolating past the holiday table: quietly treating an
 * unknown holiday as a business day would understate a deadline and manufacture
 * a breach that never happened.
 */
export function addBusinessDays(from: Date, count: number, calendar: BusinessCalendar): Date {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`business-day count must be a non-negative integer, got ${count}`);
  }

  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 23, 59, 59, 999),
  );

  let remaining = count;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (toIsoDate(cursor) > HOLIDAY_TABLE_END) throw new CalendarRangeError(toIsoDate(cursor));
    if (isBusinessDay(cursor, calendar)) remaining -= 1;
  }

  return cursor;
}

/**
 * Deadline for a redemption request under the two-business-day standard.
 *
 * A request arriving after the cutoff, on a weekend, or on a holiday is treated
 * as received on the next business day before the clock starts.
 */
export function redemptionDeadline(
  requestedAt: Date,
  calendar: BusinessCalendar,
  businessDays = 2,
): Date {
  let effective = requestedAt;

  const afterCutoff = requestedAt.getUTCHours() >= calendar.cutoffHourUtc;
  if (afterCutoff || !isBusinessDay(requestedAt, calendar)) {
    effective = addBusinessDays(requestedAt, 1, calendar);
  }

  return addBusinessDays(effective, businessDays, calendar);
}
