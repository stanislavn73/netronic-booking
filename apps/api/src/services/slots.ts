/**
 * Slot suggestion — find nearest-available windows of a given duration within
 * a forward-search horizon. Uses sweep-line primitives in `db/sweep.ts` over
 * active intervals fetched via the repo.
 *
 * Algorithm walkthrough lives in `.claude/ARCHITECTURE.md §7`.
 * Complexity: O(N log N) where N = sessions in window.
 */
import { pool } from '../db/index.js';
import { selectActiveIntervals } from '../db/sessions.repo.js';
import { buildEvents } from '../db/sweep.js';
import { ms } from '../time.js';
import { ARENA_CAPACITY } from './validation.js';

export interface Slot {
  start: Date;
  end: Date;
}

export interface SuggestSlotsOptions {
  arenaId: number;
  preferredStart: Date;
  durationMs: number;
  horizonMs?: number;
  maxResults?: number;
}

/**
 * Suggest up to `maxResults` slots that fit `durationMs` starting at or after
 * `preferredStart`, searched within `horizonMs` (default 14 days).
 */
export async function suggestSlots(opts: SuggestSlotsOptions): Promise<Slot[]> {
  const {
    arenaId,
    preferredStart,
    durationMs,
    horizonMs = 14 * ms.day,
    maxResults = 5,
  } = opts;

  const window = {
    start: preferredStart,
    end: new Date(preferredStart.getTime() + horizonMs),
  };
  const intervals = await selectActiveIntervals(pool, arenaId, window);
  const events = buildEvents(intervals, window);

  const horizonEnd = window.end.getTime();
  const results: Slot[] = [];
  let active = 0;
  let cursor = window.start.getTime();

  const emit = (gapStart: number, gapEnd: number): boolean => {
    if (gapEnd - gapStart < durationMs) return results.length >= maxResults;
    results.push({ start: new Date(gapStart), end: new Date(gapStart + durationMs) });
    return results.length >= maxResults;
  };

  for (const ev of events) {
    if (active < ARENA_CAPACITY && emit(cursor, ev.t)) return results;
    active += ev.delta;
    cursor = ev.t;
  }
  if (active < ARENA_CAPACITY) emit(cursor, horizonEnd);
  return results;
}
