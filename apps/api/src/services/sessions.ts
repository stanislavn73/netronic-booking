/**
 * Sessions service — business rules for booking, capped at {@link ARENA_CAPACITY}
 * concurrent active sessions per arena.
 *
 * SQL access lives in `db/sessions.repo.ts`. Sweep-line math in `db/sweep.ts`.
 * This file is just orchestration: validate → lock → atomic-pick-a-lane
 * INSERT/UPDATE → probe-for-meta on cap reach.
 *
 * Current concurrency model: per-arena `pg_advisory_xact_lock` (via
 * `withArenaLock`) serializes writes for the same arena. The atomic-pick-a
 * lane INSERT cannot race itself while the lock is held.
 *
 * Migration 0003 (parked — see `migrations/0003_lane_constraints.sql.pending`)
 * will add a Postgres EXCLUDE constraint that makes the cap a schema-level
 * invariant. At that point the advisory lock becomes redundant — replace
 * `withArenaLock` with `withLaneRetry` from `db/pg-errors.ts`.
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
 * Inside the per-arena advisory lock, runs the atomic-pick-a-lane INSERT.
 * If 0 rows return, the arena is at capacity for the requested window —
 * we then run a concurrency probe purely to populate `fillsUpAt` and
 * `maxAvailableDurationMinutes` on the SLOT_UNAVAILABLE meta.
 *
 * @throws DomainError<'VALIDATION_FAILED'> on Zod parse failure (re-thrown ZodError).
 * @throws DomainError<'INVALID_DURATION'> if the derived window violates bounds.
 * @throws DomainError<'ARENA_NOT_FOUND'> if `input.arenaId` doesn't exist.
 * @throws DomainError<'SLOT_UNAVAILABLE'> if no lane fits the requested window.
 */
export async function createSession(input: SessionInput): Promise<SessionRecord> {
  const norm = normalizeInput(SessionInputSchema.parse(input));
  if (!(await arenaExists(pool, norm.arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${norm.arenaId} not found`, {
      arenaId: norm.arenaId,
    });
  }
  return withArenaLock(norm.arenaId, async (client) => {
    const inserted = await insertActiveSession(client, {
      arenaId: norm.arenaId,
      start: norm.start,
      end: norm.end,
      playerName: norm.playerName ?? null,
    });
    if (inserted) return inserted;
    return throwSlotUnavailable(client, norm.arenaId, norm.start, norm.end, undefined, 'create');
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
    const result = await updateSessionRow(client, id, {
      arenaId: current.arenaId,
      start,
      end,
      playerName,
    });
    if (result.kind === 'updated') return result.row;
    if (result.kind === 'not_found') {
      throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
    }
    return throwSlotUnavailable(client, current.arenaId, start, end, id, 'update');
  });
}

/**
 * Build and throw a SLOT_UNAVAILABLE DomainError with a fresh concurrency
 * probe over the requested window. `excludeId` excludes a session from
 * the probe so update paths don't count it against itself.
 */
async function throwSlotUnavailable(
  q: Q,
  arenaId: number,
  start: Date,
  end: Date,
  excludeId: number | undefined,
  context: 'create' | 'update',
): Promise<never> {
  const window: Window = { start, end };
  const probe = await probeConcurrency(q, arenaId, window, excludeId);
  const maxAvailMs = await maxAvailableDurationMs(q, arenaId, start, undefined, excludeId);
  throw slotUnavailable({
    arenaId,
    start,
    end,
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
