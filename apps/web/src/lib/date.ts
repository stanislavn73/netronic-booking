import { addDays, format, parse, startOfDay } from 'date-fns';

/**
 * Half-open `[from, to)` window covering a single LOCAL day.
 *
 * Used by Timeline + SessionModal as the single source of truth for the
 * day-scoped sessions query — identical variables mean Apollo's cache key
 * matches across both call sites, so a mutation's refetch updates the same
 * cache entry the Timeline subscribes to.
 *
 * Half-open matches the API's `tstzrange` semantics and avoids the
 * 1-millisecond hole at `23:59:59.999` that `date-fns endOfDay` leaves.
 */
export function dayWindow(date: Date): { from: Date; to: Date } {
  return { from: startOfDay(date), to: startOfDay(addDays(date, 1)) };
}

/**
 * Format a `Date` as a `<input type="datetime-local">` value
 * (`YYYY-MM-DDTHH:mm` in LOCAL time).
 */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert a `<input type="datetime-local">` string into a UTC ISO-8601
 * string suitable for sending to the API. Returns `null` for empty / invalid
 * values so callers can early-return cleanly.
 */
export function datetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(+d) ? null : d.toISOString();
}

/**
 * Parse a `YYYY-MM-DD` value from `<input type="date">` into a Date pinned
 * to LOCAL midnight. `new Date("2026-05-27")` would parse as UTC midnight,
 * which on a non-UTC machine is the previous local day — this helper avoids
 * that footgun.
 */
export function parseDateInputValue(value: string): Date {
  return parse(value, 'yyyy-MM-dd', new Date());
}

/** `HH:mm` from an ISO-8601 instant, in local time. */
export function formatLocalHm(iso: string): string {
  return format(new Date(iso), 'HH:mm');
}

/** `MMM d, HH:mm` from an ISO-8601 instant, in local time. */
export function formatLocalShort(iso: string): string {
  return format(new Date(iso), 'MMM d, HH:mm');
}
