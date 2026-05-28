/**
 * Slot suggestion — find the nearest available windows of a given duration
 * within a forward-search horizon (default 14 days).
 *
 * Algorithm: classic sweep line over interval events.
 *
 *   1. Fetch all active sessions for the arena in [preferredStart, preferredStart + horizon).
 *   2. Build event list: each session contributes +1 at start, -1 at end.
 *      Use half-open semantics so end-event fires BEFORE simultaneous start-event
 *      (we order: end before start at the same instant, mirroring [) semantics).
 *   3. Sort, sweep: maintain `active` count, track times when `active < CAPACITY`
 *      (these are "open" intervals).
 *   4. Within each open interval, the earliest window that can fit `duration`
 *      is at its start (clamped to preferredStart).
 *   5. Return up to N earliest matching slot starts.
 *
 * Complexity: O(N log N) where N = sessions in window. With ≤ 5 lanes × few-hundred
 * sessions/day × 14 days ≈ ~10K events worst case. Sub-millisecond on the app side
 * once the data is fetched.
 */
import { pool } from '../db/index.js';
import { parseRange, rangeLiteral } from '../db/range.js';
import { ARENA_CAPACITY } from './validation.js';

export interface Slot {
  start: Date;
  end: Date;
}

interface Event {
  t: number;
  delta: number;
  /** Sort key: ends (-1) before starts (+1) at the same instant. */
  order: number;
}

export interface SuggestSlotsOptions {
  arenaId: number;
  preferredStart: Date;
  durationMs: number;
  horizonMs?: number;
  maxResults?: number;
}

export async function suggestSlots(opts: SuggestSlotsOptions): Promise<Slot[]> {
  const {
    arenaId,
    preferredStart,
    durationMs,
    horizonMs = 14 * 24 * 3600 * 1000,
    maxResults = 5,
  } = opts;

  const horizonEnd = new Date(preferredStart.getTime() + horizonMs);

  const { rows } = await pool.query<{ during: string }>(
    `
    SELECT during::text AS during
    FROM sessions
    WHERE arena_id = $1
      AND status = 'active'
      AND during && $2::tstzrange
    `,
    [arenaId, rangeLiteral(preferredStart, horizonEnd)],
  );

  // Build events, clipped to the search window.
  const events: Event[] = [];
  for (const r of rows) {
    const { start, end } = parseRange(r.during);
    const s = Math.max(start.getTime(), preferredStart.getTime());
    const e = Math.min(end.getTime(), horizonEnd.getTime());
    if (e <= s) continue;
    events.push({ t: s, delta: +1, order: 1 }); // starts after ends at same t
    events.push({ t: e, delta: -1, order: 0 });
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  // Sweep: produce "open" time-points where capacity < ARENA_CAPACITY.
  const results: Slot[] = [];
  let active = 0;
  let openStart = preferredStart.getTime();

  // Helper: when we know the "open" window [openStart, openEnd) has < CAPACITY,
  // emit any slots that fit `durationMs` inside it.
  const emitFromOpenWindow = (winStart: number, winEnd: number) => {
    if (winEnd - winStart >= durationMs && results.length < maxResults) {
      results.push({ start: new Date(winStart), end: new Date(winStart + durationMs) });
    }
  };

  // Walk events.
  let cursor = openStart;
  for (const ev of events) {
    if (active < ARENA_CAPACITY) {
      // The interval [cursor, ev.t) was "open"
      emitFromOpenWindow(cursor, ev.t);
      if (results.length >= maxResults) break;
    }
    active += ev.delta;
    cursor = ev.t;
  }
  // Tail: from last event to horizon end.
  if (active < ARENA_CAPACITY && results.length < maxResults) {
    emitFromOpenWindow(cursor, horizonEnd.getTime());
  }

  return results;
}
