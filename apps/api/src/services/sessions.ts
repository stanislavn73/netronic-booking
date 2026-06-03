/**
 * Sessions service — business rules for booking, capped at {@link ARENA_CAPACITY}
 * concurrent active sessions per arena.
 *
 * SQL access lives in `db/sessions.repo.ts`. Sweep-line math in `db/sweep.ts`.
 * This file is just orchestration: validate → lock → assert-room → INSERT/UPDATE.
 *
 * Concurrency model: per-arena `pg_advisory_xact_lock` (via `withArenaLock`)
 * serializes every create/update for the same arena. Inside that lock we run
 * a max-concurrent sweep over the proposed window (`assertHasRoom`); only if
 * peak concurrency is below the cap do we write. Because the lock blocks all
 * other writers for the arena until we COMMIT, there is no TOCTOU gap between
 * the sweep and the write. Different arenas proceed in parallel.
 *
 * Why a sweep and not a per-`lane` EXCLUDE constraint: a fixed-lane model
 * (migration 0002's `lane` column + the parked 0003 EXCLUDE) does NOT express
 * "≤ 5 at any instant" — it both under-counts pre-existing NULL-lane rows
 * (the prod ">5 booked" regression) and over-restricts valid bookings whose
 * window spans several lanes' disjoint sessions. The cap is "max concurrent",
 * so we compute exactly that, the same way `checkAvailability` does. See
 * `0002_lanes.NOTES.md` for the post-mortem.
 */
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/index.js';
import {
  arenaExists,
  cancelSession,
  insertActiveSession,
  selectActiveIntervals,
  selectActiveSessions,
  selectActiveSessionsForArenas,
  selectSessionById,
  updateSessionRow,
  type SessionRow,
} from '../db/sessions.repo.js';
import {
  maxRoomDurationMs,
  sweepConcurrency,
  type ConcurrencyProbe,
  type Window,
} from '../db/sweep.js';
import { withArenaLock } from '../db/transactions.js';
import { minutes, toMinutes } from '../time.js';
import { DomainError } from './errors.js';
import {
  ARENA_CAPACITY,
  MAX_DURATION_MIN,
  SessionInputSchema,
  UpdateSessionInputSchema,
  assertValidDuration,
  normalizeInput,
  type SessionInput,
  type UpdateSessionInput,
} from './validation.js';

/** Public session shape — re-export of the repo row. */
export type SessionRecord = SessionRow;

type Q = Pool | PoolClient;

// =============================================================================
// Internal probes — capacity questions answered via sweep over fetched intervals.
// =============================================================================

/** Peak concurrent active sessions inside `window`, with the first instant the cap is reached. */
async function probeConcurrency(
  q: Q,
  arenaId: number,
  window: Window,
  excludeId?: number,
): Promise<ConcurrencyProbe> {
  const intervals = await selectActiveIntervals(q, arenaId, window, excludeId);
  return sweepConcurrency(intervals, window, ARENA_CAPACITY);
}

/**
 * Largest duration (ms) starting at `start` for which an additional session
 * keeps active count ≤ capacity. Search bounded by `horizonMs` (default 24h).
 */
async function maxAvailableDurationMs(
  q: Q,
  arenaId: number,
  start: Date,
  horizonMs: number = minutes(MAX_DURATION_MIN),
  excludeId?: number,
): Promise<number> {
  const window: Window = { start, end: new Date(start.getTime() + horizonMs) };
  const intervals = await selectActiveIntervals(q, arenaId, window, excludeId);
  return maxRoomDurationMs(intervals, window, ARENA_CAPACITY);
}

/**
 * Compose a SLOT_UNAVAILABLE DomainError with full meta — message and meta
 * agree on the same numbers so resolvers don't need to recompute.
 */
function slotUnavailable(args: {
  arenaId: number;
  start: Date;
  end: Date;
  probe: ConcurrencyProbe;
  maxAvailableDurationMinutes: number;
  context: 'create' | 'update';
}): DomainError<'SLOT_UNAVAILABLE'> {
  const { arenaId, start, end, probe, maxAvailableDurationMinutes, context } = args;
  const action = context === 'create' ? 'your proposal' : 'moving this session there';
  const message = probe.firstFillAt
    ? `Arena ${arenaId} fills up at ${probe.firstFillAt.toISOString()} — ${action} would exceed capacity from that point on`
    : `Arena ${arenaId} is at capacity (${probe.max}/${ARENA_CAPACITY}) for the requested window`;
  return new DomainError('SLOT_UNAVAILABLE', message, {
    arenaId,
    start,
    end,
    conflictingCount: probe.max,
    fillsUpAt: probe.firstFillAt,
    maxAvailableDurationMinutes,
  });
}

// =============================================================================
// Public service API
// =============================================================================

/** Active sessions for an arena inside `[from, to)`, ordered by start. */
export const sessionsByArena = (
  arenaId: number,
  from: Date,
  to: Date,
): Promise<SessionRecord[]> => selectActiveSessions(pool, arenaId, { start: from, end: to });

/** Batched form for the per-request DataLoader. */
export const sessionsByArenaBatch = (
  arenaIds: readonly number[],
  from: Date,
  to: Date,
): Promise<Map<number, SessionRecord[]>> =>
  selectActiveSessionsForArenas(pool, arenaIds, { start: from, end: to });

export interface AvailabilityResult {
  available: boolean;
  /** Peak concurrent active sessions during the proposed window. */
  conflictingCount: number;
  capacity: number;
  /** Max duration that fits at the requested start without exceeding the cap. */
  maxAvailableDurationMinutes: number;
  /** First instant within the proposed window at which the cap is reached. */
  fillsUpAt: Date | null;
}

/**
 * Read-only capacity probe for a proposed `[start, end)`. No lock needed —
 * the answer can shift the moment we return, callers must re-check on write.
 * @throws DomainError<'ARENA_NOT_FOUND'>
 */
export async function checkAvailability(
  arenaId: number,
  start: Date,
  end: Date,
): Promise<AvailabilityResult> {
  if (!(await arenaExists(pool, arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${arenaId} not found`, { arenaId });
  }
  const probe = await probeConcurrency(pool, arenaId, { start, end });
  const maxAvailMs = await maxAvailableDurationMs(pool, arenaId, start);
  return {
    available: probe.max < ARENA_CAPACITY,
    conflictingCount: probe.max,
    capacity: ARENA_CAPACITY,
    maxAvailableDurationMinutes: toMinutes(maxAvailMs),
    fillsUpAt: probe.firstFillAt,
  };
}

/**
 * Create an active session for an arena.
 *
 * Inside the per-arena advisory lock: sweep the proposed window for peak
 * concurrency and reject with SLOT_UNAVAILABLE if it's already at the cap;
 * otherwise INSERT. The lock guarantees no other writer for this arena can
 * slip in between the sweep and the insert.
 *
 * @throws DomainError<'VALIDATION_FAILED'> on Zod parse failure (re-thrown ZodError).
 * @throws DomainError<'INVALID_DURATION'> if the derived window violates bounds.
 * @throws DomainError<'ARENA_NOT_FOUND'> if `input.arenaId` doesn't exist.
 * @throws DomainError<'SLOT_UNAVAILABLE'> if the window is already at capacity.
 */
export async function createSession(input: SessionInput): Promise<SessionRecord> {
  const norm = normalizeInput(SessionInputSchema.parse(input));
  if (!(await arenaExists(pool, norm.arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${norm.arenaId} not found`, {
      arenaId: norm.arenaId,
    });
  }
  return withArenaLock(norm.arenaId, async (client) => {
    await assertHasRoom(client, norm.arenaId, { start: norm.start, end: norm.end }, undefined, 'create');
    return insertActiveSession(client, {
      arenaId: norm.arenaId,
      start: norm.start,
      end: norm.end,
      playerName: norm.playerName ?? null,
    });
  });
}

/**
 * Update a session's window and/or playerName. `playerName: null` clears
 * it; `playerName: undefined` (the default if the field is omitted) keeps
 * the existing value.
 *
 * @throws DomainError<'VALIDATION_FAILED'> on Zod parse failure.
 * @throws DomainError<'SESSION_NOT_FOUND'>
 * @throws DomainError<'INVALID_DURATION'>
 * @throws DomainError<'SLOT_UNAVAILABLE'>
 */
export async function updateSession(
  id: number,
  input: UpdateSessionInput,
): Promise<SessionRecord> {
  const parsed = UpdateSessionInputSchema.parse(input);

  const current = await selectSessionById(pool, id);
  if (!current) {
    throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
  }

  const start = parsed.startTime ?? current.startTime;
  const end =
    parsed.endTime ??
    (parsed.durationMinutes
      ? new Date(start.getTime() + minutes(parsed.durationMinutes))
      : current.endTime);
  assertValidDuration(start, end);

  const playerName = parsed.playerName === undefined ? current.playerName : parsed.playerName;
  return withArenaLock(current.arenaId, async (client) => {
    // Exclude this session from the probe so it doesn't count against itself.
    await assertHasRoom(client, current.arenaId, { start, end }, id, 'update');
    const result = await updateSessionRow(client, id, { start, end, playerName });
    if (result.kind === 'not_found') {
      throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
    }
    return result.row;
  });
}

/**
 * Guard a write: throw SLOT_UNAVAILABLE if adding one session spanning
 * `window` would push peak concurrency past the cap. A new session covers the
 * whole window, so it adds +1 at every instant — there is room iff existing
 * peak concurrency is strictly below {@link ARENA_CAPACITY}. `excludeId`
 * drops a session from the probe so update paths don't count it against
 * itself. Must run under the arena lock so the answer can't go stale before
 * the write.
 *
 * Counts ALL active rows in the window regardless of any `lane` value, which
 * is what makes it correct against pre-existing (NULL-lane) data.
 */
async function assertHasRoom(
  q: Q,
  arenaId: number,
  window: Window,
  excludeId: number | undefined,
  context: 'create' | 'update',
): Promise<void> {
  const probe = await probeConcurrency(q, arenaId, window, excludeId);
  if (probe.max < ARENA_CAPACITY) return;
  const maxAvailMs = await maxAvailableDurationMs(q, arenaId, window.start, undefined, excludeId);
  throw slotUnavailable({
    arenaId,
    start: window.start,
    end: window.end,
    probe,
    maxAvailableDurationMinutes: toMinutes(maxAvailMs),
    context,
  });
}

/**
 * Soft-cancel a session (`status = 'cancelled'`). Keeps history, frees the slot.
 * @throws DomainError<'SESSION_NOT_FOUND'>
 */
export async function deleteSession(id: number): Promise<{ id: number }> {
  const cancelled = await cancelSession(pool, id);
  if (cancelled === null) {
    throw new DomainError(
      'SESSION_NOT_FOUND',
      `Session ${id} not found or already cancelled`,
      { sessionId: id },
    );
  }
  return { id: cancelled };
}
