import type { Session } from '@/lib/types';

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * MS_PER_HOUR;

/** Per-hour density summary used by the Timeline's row chips. */
export interface HourDensity {
  /** Maximum concurrent active sessions seen during the hour. */
  peak: number;
  /**
   * Fraction (0..1) of the hour during which the active count was at or
   * above `capacity`. A value near 0 means a brief spike; near 1 means the
   * hour is almost entirely saturated. Used to tune the chip's colour so a
   * one-minute spike doesn't paint a whole hour red.
   */
  capFraction: number;
}

/**
 * Per-hour density for the displayed day.
 *
 * Mirrors the server's sweep for visual purposes only; cap enforcement
 * remains server-side. Used by {@link DensityChip} (via the Timeline) to
 * render the `n/5` chip alongside a colour tone driven by how much of the
 * hour is actually saturated.
 *
 * @param sessions   All sessions overlapping the displayed day.
 * @param dayStartMs Local midnight of the displayed day, as ms-since-epoch.
 * @param capacity   Lane cap (typically 5). Hours never reach `capacity`
 *                   are reported with `capFraction: 0`.
 */
export function hourlyDensity(
  sessions: readonly Session[],
  dayStartMs: number,
  capacity: number,
): HourDensity[] {
  const out: HourDensity[] = Array.from({ length: HOURS_PER_DAY }, () => ({
    peak: 0,
    capFraction: 0,
  }));
  if (sessions.length === 0) return out;

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

  // Per-hour accumulator of milliseconds spent at-or-above `capacity`.
  const capMsByHour = new Array<number>(HOURS_PER_DAY).fill(0);

  /**
   * For every segment `[segStart, segEnd)` during which `active` is constant,
   * update each spanned hour's `peak` and accumulate `capMs` when saturated.
   */
  const applySegment = (segStart: number, segEnd: number, active: number) => {
    if (segEnd <= segStart) return;
    const startHour = Math.floor((segStart - dayStartMs) / MS_PER_HOUR);
    const endHour = Math.floor((segEnd - 1 - dayStartMs) / MS_PER_HOUR);
    for (let h = Math.max(0, startHour); h <= Math.min(HOURS_PER_DAY - 1, endHour); h++) {
      const hourStart = dayStartMs + h * MS_PER_HOUR;
      const hourEnd = hourStart + MS_PER_HOUR;
      const overlapStart = Math.max(segStart, hourStart);
      const overlapEnd = Math.min(segEnd, hourEnd);
      if (overlapEnd <= overlapStart) continue;
      const slot = out[h]!;
      if (active > slot.peak) slot.peak = active;
      if (active >= capacity) capMsByHour[h] = (capMsByHour[h] ?? 0) + (overlapEnd - overlapStart);
    }
  };

  let active = 0;
  let prevT = dayStartMs;
  for (const ev of events) {
    applySegment(prevT, ev.t, active);
    active += ev.delta;
    prevT = ev.t;
  }
  // Tail segment from last event to end of day.
  applySegment(prevT, dayStartMs + DAY_MS, active);

  for (let h = 0; h < HOURS_PER_DAY; h++) {
    out[h]!.capFraction = (capMsByHour[h] ?? 0) / MS_PER_HOUR;
  }
  return out;
}
