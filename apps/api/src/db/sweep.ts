/**
 * Sweep-line primitives over half-open `[start, end)` intervals.
 *
 * Each interval is clipped to the given `window` so callers ignore boundary
 * math. Events are sorted so end-events fire BEFORE start-events at the same
 * instant — that's what makes touching intervals count as non-overlapping
 * (matching Postgres `tstzrange &&` half-open semantics used by the rest of
 * the system).
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface Window {
  start: Date;
  end: Date;
}

export interface SweepEvent {
  t: number;
  delta: 1 | -1;
  /** 0 = end (fires first), 1 = start. */
  tie: 0 | 1;
}

/**
 * Build sorted +1/-1 events for `intervals`, clipped to `window`.
 * Intervals fully outside the window are skipped.
 */
export function buildEvents(intervals: Iterable<Interval>, window: Window): SweepEvent[] {
  const winStart = window.start.getTime();
  const winEnd = window.end.getTime();
  const events: SweepEvent[] = [];
  for (const { start, end } of intervals) {
    const s = Math.max(start.getTime(), winStart);
    const e = Math.min(end.getTime(), winEnd);
    if (e <= s) continue;
    events.push({ t: s, delta: +1, tie: 1 });
    events.push({ t: e, delta: -1, tie: 0 });
  }
  events.sort((a, b) => a.t - b.t || a.tie - b.tie);
  return events;
}

export interface ConcurrencyProbe {
  /** Peak concurrent intervals observed anywhere inside `window`. */
  max: number;
  /** Earliest instant at which active count reaches `capLimit`, or null. */
  firstFillAt: Date | null;
}

/**
 * Single-pass sweep producing peak concurrency and the first instant the
 * given `capLimit` is reached.
 *
 * @param intervals Existing intervals (typically rows fetched from DB).
 * @param window    Time range to evaluate inside.
 * @param capLimit  Threshold treated as "full".
 */
export function sweepConcurrency(
  intervals: Iterable<Interval>,
  window: Window,
  capLimit: number,
): ConcurrencyProbe {
  const events = buildEvents(intervals, window);
  let active = 0;
  let max = 0;
  let firstFillAt: Date | null = null;
  for (const ev of events) {
    active += ev.delta;
    if (active > max) max = active;
    if (firstFillAt === null && active >= capLimit) firstFillAt = new Date(ev.t);
  }
  return { max, firstFillAt };
}

/**
 * Largest offset from `window.start` (in ms) for which adding one new
 * interval keeps active count strictly below `capLimit` throughout. Returns
 * the full window length if the cap is never reached.
 */
export function maxRoomDurationMs(
  intervals: Iterable<Interval>,
  window: Window,
  capLimit: number,
): number {
  const events = buildEvents(intervals, window);
  const startMs = window.start.getTime();
  let active = 0;
  for (const ev of events) {
    active += ev.delta;
    if (active >= capLimit) return Math.max(0, ev.t - startMs);
  }
  return window.end.getTime() - startMs;
}
