/**
 * Calendar-month timing for anonymous OAuth client_id tokens.
 *
 * Tokens embed a YYYY-MM field and remain acceptable for the current calendar
 * month plus one month of grace. Arithmetic is integer year/month only —
 * never Date setters (which silently overflow on day-31 boundaries).
 */

type YearMonth = { year: number; month: number }; // month is 1–12

function readUtcYearMonthNow(): YearMonth {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function shiftYearMonth(year: number, month: number, deltaMonths: number): YearMonth {
  const absolute = year * 12 + (month - 1) + deltaMonths;
  const shiftedYear = Math.floor(absolute / 12);
  const shiftedMonth = absolute - shiftedYear * 12 + 1;
  return { year: shiftedYear, month: shiftedMonth };
}

function formatYearMonth({ year, month }: YearMonth): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export class ClientTokenMonthCalculations {
  /** YYYY-MM written into a new anonymous client_id token. */
  static monthForNewToken(): string {
    return formatYearMonth(readUtcYearMonthNow());
  }

  /** Whether a token's month is still inside the allowed timing window. */
  static isTokenMonthStillValid(monthFromToken: string): boolean {
    const current = readUtcYearMonthNow();
    const previous = shiftYearMonth(current.year, current.month, -1);
    return (
      monthFromToken === formatYearMonth(current) ||
      monthFromToken === formatYearMonth(previous)
    );
  }
}
