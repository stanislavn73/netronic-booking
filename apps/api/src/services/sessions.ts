/**
 * Sessions service — business rules for booking, capped at {@link ARENA_CAPACITY}
 * concurrent active sessions per arena.
 *
 * SQL access lives in `db/sessions.repo.ts`. Sweep-line math in `db/sweep.ts`.
 * This file is just orchestration: validate → lock → probe → write.
 *
 * Concurrency rationale and the "max-concurrent vs total-overlap" trade-off
 * are documented in `.claude/ARCHITECTURE.md §7`. Don't replace the sweep
 * with `COUNT(*)`.
 */
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/index.js';
import {
  arenaExists,
  cancelSession,
  getArenaById,
  insertActiveSession,
  listArenas as listArenasRepo,
  selectActiveIntervals,
  selectActiveSessions,
  selectActiveSessionsForArenas,
  selectSessionById,
  updateSessionRow,
  type ArenaRow,
  type ListArenasArgs,
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
  assertValidDuration,
  normalizeInput,
  type SessionInput,
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

/** List arenas with optional ILIKE search; bounded pagination. */
export const listArenas = (args: ListArenasArgs = {}): Promise<ArenaRow[]> => listArenasRepo(args);

/** Single arena by id, or null. */
export const getArena = (id: number): Promise<ArenaRow | null> => getArenaById(id);

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
 * @throws DomainError<'VALIDATION_FAILED'> on Zod parse failure (re-thrown ZodError).
 * @throws DomainError<'INVALID_DURATION'> if the derived window violates bounds.
 * @throws DomainError<'ARENA_NOT_FOUND'> if `input.arenaId` doesn't exist.
 * @throws DomainError<'SLOT_UNAVAILABLE'> if the window would exceed capacity.
 */
export async function createSession(input: SessionInput): Promise<SessionRecord> {
  const norm = normalizeInput(SessionInputSchema.parse(input));
  if (!(await arenaExists(pool, norm.arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${norm.arenaId} not found`, {
      arenaId: norm.arenaId,
    });
  }
  return withArenaLock(norm.arenaId, async (client) => {
    const window: Window = { start: norm.start, end: norm.end };
    const probe = await probeConcurrency(client, norm.arenaId, window);
    if (probe.max >= ARENA_CAPACITY) {
      const maxAvailMs = await maxAvailableDurationMs(client, norm.arenaId, norm.start);
      throw slotUnavailable({
        arenaId: norm.arenaId,
        start: norm.start,
        end: norm.end,
        probe,
        maxAvailableDurationMinutes: toMinutes(maxAvailMs),
        context: 'create',
      });
    }
    return insertActiveSession(client, {
      arenaId: norm.arenaId,
      start: norm.start,
      end: norm.end,
      playerName: norm.playerName ?? null,
    });
  });
}

export interface UpdateSessionInput {
  startTime?: Date;
  endTime?: Date;
  durationMinutes?: number;
  /** `undefined` keeps existing; explicit `null` or string overwrites. */
  playerName?: string | null;
}

/**
 * Update a session's window and/or playerName.
 * @throws DomainError<'SESSION_NOT_FOUND'>
 * @throws DomainError<'INVALID_DURATION'>
 * @throws DomainError<'SLOT_UNAVAILABLE'>
 */
export async function updateSession(
  id: number,
  input: UpdateSessionInput,
): Promise<SessionRecord> {
  // Resolve arena and current window from a stable snapshot before locking.
  const current = await selectSessionById(pool, id);
  if (!current) {
    throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
  }

  const start = input.startTime ?? current.startTime;
  const end =
    input.endTime ??
    (input.durationMinutes
      ? new Date(start.getTime() + minutes(input.durationMinutes))
      : current.endTime);
  assertValidDuration(start, end);

  return withArenaLock(current.arenaId, async (client) => {
    // Re-read inside the lock so playerName writes don't race a concurrent update.
    const locked = await selectSessionById(client, id);
    if (!locked) {
      throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
    }
    const window: Window = { start, end };
    const probe = await probeConcurrency(client, locked.arenaId, window, id);
    if (probe.max >= ARENA_CAPACITY) {
      const maxAvailMs = await maxAvailableDurationMs(
        client,
        locked.arenaId,
        start,
        undefined,
        id,
      );
      throw slotUnavailable({
        arenaId: locked.arenaId,
        start,
        end,
        probe,
        maxAvailableDurationMinutes: toMinutes(maxAvailMs),
        context: 'update',
      });
    }
    const playerName = input.playerName === undefined ? locked.playerName : input.playerName;
    const updated = await updateSessionRow(client, id, { start, end, playerName });
    if (!updated) {
      throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`, { sessionId: id });
    }
    return updated;
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
