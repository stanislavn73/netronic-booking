/**
 * Pure unit tests for the sweep-line primitives in `db/sweep.ts`. No DB.
 *
 * These pin the rules the cap-check depends on:
 *   - end-events fire BEFORE start-events at the same instant
 *   - intervals are clipped to `window` before sweeping
 *   - `sweepConcurrency` returns peak + first instant cap is reached
 *   - `maxRoomDurationMs` returns the offset until the cap is hit
 *
 * If you refactor sweep.ts, these tests catch any drift.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEvents,
  maxRoomDurationMs,
  sweepConcurrency,
  type Interval,
} from '../src/db/sweep.js';

const d = (iso: string) => new Date(iso);
const i = (start: string, end: string): Interval => ({ start: d(start), end: d(end) });

const WINDOW = { start: d('2026-01-01T10:00:00Z'), end: d('2026-01-01T18:00:00Z') };

describe('buildEvents', () => {
  it('returns no events for empty intervals', () => {
    expect(buildEvents([], WINDOW)).toEqual([]);
  });

  it('skips intervals fully outside the window', () => {
    expect(buildEvents([i('2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z')], WINDOW)).toEqual([]);
    expect(buildEvents([i('2026-01-01T19:00:00Z', '2026-01-01T20:00:00Z')], WINDOW)).toEqual([]);
  });

  it('clips intervals straddling the window edges', () => {
    const events = buildEvents([i('2026-01-01T09:00:00Z', '2026-01-01T11:00:00Z')], WINDOW);
    expect(events).toHaveLength(2);
    expect(events[0]!.t).toBe(WINDOW.start.getTime());
    expect(events[0]!.delta).toBe(1);
    expect(events[1]!.t).toBe(d('2026-01-01T11:00:00Z').getTime());
    expect(events[1]!.delta).toBe(-1);
  });

  it('orders end-events BEFORE start-events at the same instant', () => {
    // Two intervals touching at 11:00 — A ends, B starts.
    const events = buildEvents(
      [i('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'), i('2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z')],
      WINDOW,
    );
    // Find the two events at 11:00 and assert the end (-1) comes first.
    const atEleven = events.filter((e) => e.t === d('2026-01-01T11:00:00Z').getTime());
    expect(atEleven).toHaveLength(2);
    expect(atEleven[0]!.delta).toBe(-1);
    expect(atEleven[1]!.delta).toBe(+1);
  });
});

describe('sweepConcurrency', () => {
  it('returns zero peak for an empty window', () => {
    expect(sweepConcurrency([], WINDOW, 5)).toEqual({ max: 0, firstFillAt: null });
  });

  it('counts two overlapping intervals as peak=2', () => {
    const result = sweepConcurrency(
      [
        i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
        i('2026-01-01T11:00:00Z', '2026-01-01T13:00:00Z'),
      ],
      WINDOW,
      5,
    );
    expect(result.max).toBe(2);
    expect(result.firstFillAt).toBeNull();
  });

  it('treats touching intervals as non-overlapping (peak stays at 1)', () => {
    const result = sweepConcurrency(
      [
        i('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
        i('2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'),
      ],
      WINDOW,
      5,
    );
    expect(result.max).toBe(1);
  });

  it('reports firstFillAt at the instant the cap is reached', () => {
    // Four intervals from 10:00–12:00, plus a fifth from 11:00 — cap hits at 11:00.
    const result = sweepConcurrency(
      [
        i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
        i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
        i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
        i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
        i('2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'),
      ],
      WINDOW,
      5,
    );
    expect(result.max).toBe(5);
    expect(result.firstFillAt).toEqual(d('2026-01-01T11:00:00Z'));
  });

  it('handles containment — inner interval increments the peak', () => {
    const result = sweepConcurrency(
      [
        i('2026-01-01T10:00:00Z', '2026-01-01T14:00:00Z'),
        i('2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'),
      ],
      WINDOW,
      5,
    );
    expect(result.max).toBe(2);
  });

  it('clips intervals before counting (one straddles the window edge)', () => {
    // Only the inside portion contributes — peak is 1.
    const result = sweepConcurrency(
      [i('2026-01-01T08:00:00Z', '2026-01-01T11:00:00Z')],
      WINDOW,
      5,
    );
    expect(result.max).toBe(1);
  });
});

describe('maxRoomDurationMs', () => {
  it('returns the full window length when nothing overlaps', () => {
    const room = maxRoomDurationMs([], WINDOW, 5);
    expect(room).toBe(WINDOW.end.getTime() - WINDOW.start.getTime());
  });

  it('returns 0 when the cap is already reached at window.start', () => {
    // 5 sessions all active at 10:00 — adding one more would breach.
    const intervals = Array.from({ length: 5 }, () =>
      i('2026-01-01T09:00:00Z', '2026-01-01T12:00:00Z'),
    );
    expect(maxRoomDurationMs(intervals, WINDOW, 5)).toBe(0);
  });

  it('returns the offset until the cap is first reached', () => {
    // 4 sessions present from window.start; a 5th starts at 11:00.
    const intervals = [
      i('2026-01-01T10:00:00Z', '2026-01-01T14:00:00Z'),
      i('2026-01-01T10:00:00Z', '2026-01-01T14:00:00Z'),
      i('2026-01-01T10:00:00Z', '2026-01-01T14:00:00Z'),
      i('2026-01-01T10:00:00Z', '2026-01-01T14:00:00Z'),
      i('2026-01-01T11:00:00Z', '2026-01-01T14:00:00Z'),
    ];
    expect(maxRoomDurationMs(intervals, WINDOW, 5)).toBe(60 * 60 * 1000);
  });

  it('returns full length when peak stays strictly below the cap', () => {
    const intervals = [
      i('2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
      i('2026-01-01T11:00:00Z', '2026-01-01T13:00:00Z'),
    ];
    expect(maxRoomDurationMs(intervals, WINDOW, 5)).toBe(
      WINDOW.end.getTime() - WINDOW.start.getTime(),
    );
  });
});
