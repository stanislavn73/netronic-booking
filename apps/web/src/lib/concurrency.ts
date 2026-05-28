import type { Session } from '@/lib/types';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * MS_PER_HOUR;

/**
 * Per-hour peak concurrent active session count for the displayed day.
 *
 * Mirrors the server's `services/sessions.ts → maxConcurrentDuring` sweep
 * for visual purposes only; the server remains the source of truth for cap
 * enforcement. Used by `<DensityChip />` to render the `n/5` badge per row.
 *
 * @param sessions   All sessions overlapping the displayed day.
 * @param dayStartMs Local midnight of the displayed day, as ms-since-epoch.
 * @returns          A length-24 array of peak concurrent counts per hour.
 */
export function hourlyPeakConcurrent(
  sessions: readonly Session[],
  dayStartMs: number,
): number[] {
  const peaks = new Array<number>(HOURS_PER_DAY).fill(0);
  if (sessions.length === 0) return peaks;

  type Event = { t: number; delta: number; order: number };
  const events: Event[] = [];
  for (const s of sessions) {
    const sMs = Math.max(+new Date(s.startTime), dayStartMs);
    const eMs = Math.min(+new Date(s.endTime), dayStartMs + DAY_MS);
    if (eMs <= sMs) continue;
    // Order: -1 (ends) before +1 (starts) at the same instant so two sessions
    // where one ends exactly when the next begins don't count as concurrent.
    events.push({ t: sMs, delta: +1, order: 1 });
    events.push({ t: eMs, delta: -1, order: 0 });
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  let active = 0;
  let cursorHour = 0;
  const bump = (hour: number, value: number) => {
    if (hour >= 0 && hour < HOURS_PER_DAY && value > (peaks[hour] ?? 0)) {
      peaks[hour] = value;
    }
  };
  for (const ev of events) {
    // Hours fully spanned between previous cursor and `ev.t` see the
    // current `active` count unchanged — record it as a candidate peak.
    while (cursorHour < HOURS_PER_DAY && dayStartMs + (cursorHour + 1) * MS_PER_HOUR <= ev.t) {
      bump(cursorHour, active);
      cursorHour += 1;
    }
    const evHour = Math.min(HOURS_PER_DAY - 1, Math.floor((ev.t - dayStartMs) / MS_PER_HOUR));
    bump(evHour, active);
    active += ev.delta;
    bump(evHour, active);
  }
  // Tail: from the last event to end of day, `active` is constant.
  while (cursorHour < HOURS_PER_DAY) {
    bump(cursorHour, active);
    cursorHour += 1;
  }
  return peaks;
}
