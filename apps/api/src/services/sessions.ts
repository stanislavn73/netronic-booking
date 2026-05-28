/**
 * Sessions service — the heart of the system.
 *
 * The ≤5-concurrent rule is enforced inside a per-arena advisory lock
 * (pg_advisory_xact_lock) held for the duration of the transaction. This:
 *
 *   1. Serializes writes ONLY for the same arena — different arenas don't block.
 *   2. Is cheaper than SELECT FOR UPDATE on the arena row (no row contention).
 *   3. Is simpler than SERIALIZABLE + retry (no retry loop, no deadlock dance).
 *
 * The overlap query uses the && operator on tstzrange, which (combined with
 * our half-open [) literals) implements the "touching is not overlap" rule.
 *
 * Trade-offs considered but rejected — see README "Concurrency".
 */
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/index.js';
import { rangeLiteral, parseRange } from '../db/range.js';
import { DomainError } from './errors.js';
import {
  ARENA_CAPACITY,
  MAX_DURATION_MIN,
  type NormalizedSession,
  normalizeInput,
  SessionInputSchema,
  type SessionInput,
} from './validation.js';

export interface SessionRecord {
  id: number;
  arenaId: number;
  startTime: Date;
  endTime: Date;
  playerName: string | null;
  status: 'active' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

function rowToRecord(r: {
  id: string | number;
  arena_id: string | number;
  during: string;
  player_name: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}): SessionRecord {
  const { start, end } = parseRange(r.during);
  return {
    id: Number(r.id),
    arenaId: Number(r.arena_id),
    startTime: start,
    endTime: end,
    playerName: r.player_name,
    status: r.status as 'active' | 'cancelled',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Stable bigint lock key from arena_id. */
function lockKey(arenaId: number): bigint {
  // pg_advisory_xact_lock(bigint) — fits arena_id directly.
  return BigInt(arenaId);
}

async function withArenaLock<T>(
  arenaId: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(arenaId).toString()]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function arenaExists(client: PoolClient | Pool, arenaId: number): Promise<boolean> {
  const { rowCount } = await client.query('SELECT 1 FROM arenas WHERE id = $1', [arenaId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Result of a concurrency probe over a window.
 *   - `max`         : peak number of simultaneously active sessions seen.
 *   - `firstFillAt` : the first instant where the running count reaches CAPACITY,
 *                     or `null` if the cap is never hit in this window.
 *                     Used to surface "your booking would conflict at HH:MM" UX.
 */
interface ConcurrencyProbe {
  max: number;
  firstFillAt: Date | null;
}

/**
 * Maximum number of ACTIVE sessions simultaneously running at any instant
 * inside the half-open window [start, end), plus the first instant at which
 * the cap is reached.
 *
 * Why max-concurrent and not COUNT(*) of overlapping rows:
 *   The spec says "the system shall not allow create/update if AT ANY MOMENT
 *   the number of active sessions exceeds 5." `COUNT(*)` answers "how many
 *   sessions touch the window" — which over-counts for any proposed window
 *   that's longer than the briefest existing session it touches. A 3-hour
 *   proposal in a dense arena trivially touches 8+ sessions even though only
 *   5 are concurrent at any instant. The cap check must compare against the
 *   peak concurrent count, computed via a sweep over the clipped events.
 *
 * `excludeId` is used by update() so a session doesn't count against itself.
 */
async function maxConcurrentDuring(
  client: PoolClient,
  arenaId: number,
  start: Date,
  end: Date,
  excludeId?: number,
): Promise<ConcurrencyProbe> {
  const { rows } = await client.query<{ s: Date; e: Date }>(
    `
    SELECT lower(during) AS s, upper(during) AS e
    FROM sessions
    WHERE arena_id = $1
      AND status = 'active'
      AND during && $2::tstzrange
      ${excludeId ? 'AND id <> $3' : ''}
    `,
    excludeId
      ? [arenaId, rangeLiteral(start, end), excludeId]
      : [arenaId, rangeLiteral(start, end)],
  );
  if (rows.length === 0) return { max: 0, firstFillAt: null };

  // Sweep-line over events CLIPPED to the proposed window. Each session
  // contributes +1 when it (re-)enters the window and -1 when it leaves.
  // Sort: at the same instant, -1 (ends) must fire BEFORE +1 (starts) so two
  // sessions where one ends exactly when the next begins don't count as
  // concurrent — that's the half-open semantics the rest of the system uses.
  const winStart = start.getTime();
  const winEnd = end.getTime();
  type Event = { t: number; delta: number; order: number };
  const events: Event[] = [];
  for (const r of rows) {
    const sMs = Math.max(new Date(r.s).getTime(), winStart);
    const eMs = Math.min(new Date(r.e).getTime(), winEnd);
    if (eMs <= sMs) continue;
    events.push({ t: sMs, delta: +1, order: 1 });
    events.push({ t: eMs, delta: -1, order: 0 });
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  let active = 0;
  let max = 0;
  let firstFillAt: Date | null = null;
  for (const ev of events) {
    active += ev.delta;
    if (active > max) max = active;
    if (firstFillAt === null && active >= ARENA_CAPACITY) {
      firstFillAt = new Date(ev.t);
    }
  }
  return { max, firstFillAt };
}

/**
 * How long a new session starting at `start` could run without exceeding the
 * cap. Returns the largest duration (in ms) such that, throughout
 * `[start, start + duration)`, the count of existing active sessions stays
 * STRICTLY BELOW capacity (so adding this proposal keeps total ≤ capacity).
 *
 * The function caps its own search at `horizonMs` (default 24h — the spec's
 * max session duration). Returns 0 if the arena is already saturated at the
 * requested instant.
 */
async function maxAvailableDurationMs(
  client: PoolClient,
  arenaId: number,
  start: Date,
  horizonMs: number = MAX_DURATION_MIN * 60_000,
  excludeId?: number,
): Promise<number> {
  const startMs = start.getTime();
  const horizonEndMs = startMs + horizonMs;
  const horizonEnd = new Date(horizonEndMs);

  const { rows } = await client.query<{ s: Date; e: Date }>(
    `
    SELECT lower(during) AS s, upper(during) AS e
    FROM sessions
    WHERE arena_id = $1
      AND status = 'active'
      AND during && $2::tstzrange
      ${excludeId ? 'AND id <> $3' : ''}
    `,
    excludeId
      ? [arenaId, rangeLiteral(start, horizonEnd), excludeId]
      : [arenaId, rangeLiteral(start, horizonEnd)],
  );
  if (rows.length === 0) return horizonMs;

  type Event = { t: number; delta: number; order: number };
  const events: Event[] = [];
  for (const r of rows) {
    const sMs = Math.max(new Date(r.s).getTime(), startMs);
    const eMs = Math.min(new Date(r.e).getTime(), horizonEndMs);
    if (eMs <= sMs) continue;
    events.push({ t: sMs, delta: +1, order: 1 });
    events.push({ t: eMs, delta: -1, order: 0 });
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  // Walk events; the first time active reaches CAPACITY is the upper bound
  // of how long our proposal can run. Until then, adding 1 keeps total ≤ cap.
  let active = 0;
  for (const ev of events) {
    active += ev.delta;
    if (active >= ARENA_CAPACITY) return Math.max(0, ev.t - startMs);
  }
  return horizonMs;
}

// =============================================================================
// Public service API
// =============================================================================

export async function listArenas(
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<Array<{ id: number; name: string; createdAt: Date }>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();
  const params: unknown[] = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE name ILIKE $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>(
    `SELECT id, name, created_at FROM arenas ${where}
     ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, createdAt: r.created_at }));
}

export async function getArena(id: number) {
  const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>(
    'SELECT id, name, created_at FROM arenas WHERE id = $1',
    [id],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), name: r.name, createdAt: r.created_at } : null;
}

export async function sessionsByArena(
  arenaId: number,
  from: Date,
  to: Date,
): Promise<SessionRecord[]> {
  // Overlap window query: any session whose range && [from, to) is included.
  const { rows } = await pool.query(
    `
    SELECT id, arena_id, during::text AS during, player_name, status, created_at, updated_at
    FROM sessions
    WHERE arena_id = $1
      AND status = 'active'
      AND during && $2::tstzrange
    ORDER BY lower(during) ASC
    `,
    [arenaId, rangeLiteral(from, to)],
  );
  return rows.map(rowToRecord);
}

export async function sessionsByArenaBatch(
  arenaIds: readonly number[],
  from: Date,
  to: Date,
): Promise<Map<number, SessionRecord[]>> {
  if (arenaIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `
    SELECT id, arena_id, during::text AS during, player_name, status, created_at, updated_at
    FROM sessions
    WHERE arena_id = ANY($1::bigint[])
      AND status = 'active'
      AND during && $2::tstzrange
    ORDER BY arena_id, lower(during) ASC
    `,
    [arenaIds, rangeLiteral(from, to)],
  );
  const grouped = new Map<number, SessionRecord[]>();
  for (const id of arenaIds) grouped.set(id, []);
  for (const r of rows) {
    const rec = rowToRecord(r);
    grouped.get(rec.arenaId)!.push(rec);
  }
  return grouped;
}

export interface AvailabilityResult {
  available: boolean;
  /** Peak concurrent active sessions during the proposed window. */
  conflictingCount: number;
  capacity: number;
  /**
   * Max duration (minutes) that COULD fit at the requested start without
   * exceeding the cap. Useful for UI to surface "your slot fits up to N min"
   * when the requested duration is too long.
   */
  maxAvailableDurationMinutes: number;
  /**
   * First instant within the proposed window at which the cap is reached,
   * if any. `null` if the proposal would not exceed the cap.
   */
  fillsUpAt: Date | null;
}

export async function checkAvailability(
  arenaId: number,
  start: Date,
  end: Date,
): Promise<AvailabilityResult> {
  if (!(await arenaExists(pool, arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${arenaId} not found`);
  }
  const client = await pool.connect();
  try {
    const probe = await maxConcurrentDuring(client, arenaId, start, end);
    const maxAvailMs = await maxAvailableDurationMs(client, arenaId, start);
    return {
      available: probe.max < ARENA_CAPACITY,
      conflictingCount: probe.max,
      capacity: ARENA_CAPACITY,
      maxAvailableDurationMinutes: Math.floor(maxAvailMs / 60_000),
      fillsUpAt: probe.firstFillAt,
    };
  } finally {
    client.release();
  }
}

export async function createSession(input: SessionInput): Promise<SessionRecord> {
  const parsed = SessionInputSchema.parse(input);
  const norm: NormalizedSession = normalizeInput(parsed);

  if (!(await arenaExists(pool, norm.arenaId))) {
    throw new DomainError('ARENA_NOT_FOUND', `Arena ${norm.arenaId} not found`);
  }

  return withArenaLock(norm.arenaId, async (client) => {
    const probe = await maxConcurrentDuring(client, norm.arenaId, norm.start, norm.end);
    if (probe.max >= ARENA_CAPACITY) {
      const maxAvailMs = await maxAvailableDurationMs(client, norm.arenaId, norm.start);
      throw new DomainError(
        'SLOT_UNAVAILABLE',
        probe.firstFillAt
          ? `Arena ${norm.arenaId} fills up at ${probe.firstFillAt.toISOString()} — your proposal would exceed capacity from that point on`
          : `Arena ${norm.arenaId} is at capacity (${probe.max}/${ARENA_CAPACITY}) for the requested window`,
        {
          arenaId: norm.arenaId,
          start: norm.start,
          end: norm.end,
          conflictingCount: probe.max,
          fillsUpAt: probe.firstFillAt,
          maxAvailableDurationMinutes: Math.floor(maxAvailMs / 60_000),
        },
      );
    }
    const { rows } = await client.query(
      `
      INSERT INTO sessions (arena_id, during, player_name, status)
      VALUES ($1, $2::tstzrange, $3, 'active')
      RETURNING id, arena_id, during::text AS during, player_name, status, created_at, updated_at
      `,
      [norm.arenaId, rangeLiteral(norm.start, norm.end), norm.playerName ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('INSERT did not return a row — unreachable');
    return rowToRecord(row);
  });
}

export interface UpdateSessionInput {
  startTime?: Date;
  endTime?: Date;
  durationMinutes?: number;
  playerName?: string | null;
}

export async function updateSession(id: number, input: UpdateSessionInput): Promise<SessionRecord> {
  // Fetch current to know arenaId for the lock.
  const { rows: cur } = await pool.query(
    `SELECT id, arena_id, during::text AS during, player_name, status, created_at, updated_at
     FROM sessions WHERE id = $1`,
    [id],
  );
  const current = cur[0];
  if (!current) throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`);
  const currentRec = rowToRecord(current);

  const start = input.startTime ?? currentRec.startTime;
  const end =
    input.endTime ??
    (input.durationMinutes
      ? new Date(start.getTime() + input.durationMinutes * 60_000)
      : currentRec.endTime);

  const durMs = end.getTime() - start.getTime();
  if (durMs < 5 * 60_000 || durMs > 24 * 60 * 60_000) {
    throw new DomainError('INVALID_DURATION', `Duration out of bounds (got ${durMs / 60_000}m)`);
  }

  return withArenaLock(currentRec.arenaId, async (client) => {
    const probe = await maxConcurrentDuring(client, currentRec.arenaId, start, end, id);
    if (probe.max >= ARENA_CAPACITY) {
      const maxAvailMs = await maxAvailableDurationMs(client, currentRec.arenaId, start, undefined, id);
      throw new DomainError(
        'SLOT_UNAVAILABLE',
        probe.firstFillAt
          ? `Arena ${currentRec.arenaId} fills up at ${probe.firstFillAt.toISOString()} — moving this session there would exceed capacity`
          : `Arena ${currentRec.arenaId} would exceed capacity if this session moved here`,
        {
          arenaId: currentRec.arenaId,
          start,
          end,
          conflictingCount: probe.max,
          fillsUpAt: probe.firstFillAt,
          maxAvailableDurationMinutes: Math.floor(maxAvailMs / 60_000),
        },
      );
    }
    // playerName semantics: `undefined` keeps existing, anything else (string|null)
    // overwrites. The UI always sends an explicit value, so this is a no-op in
    // practice but matters for direct API consumers (curl, integration scripts).
    const finalPlayerName =
      input.playerName === undefined ? currentRec.playerName : input.playerName;
    const { rows } = await client.query(
      `
      UPDATE sessions
      SET during = $2::tstzrange,
          player_name = $3
      WHERE id = $1
      RETURNING id, arena_id, during::text AS during, player_name, status, created_at, updated_at
      `,
      [id, rangeLiteral(start, end), finalPlayerName],
    );
    const updated = rows[0];
    if (!updated) throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found`);
    return rowToRecord(updated);
  });
}

export async function deleteSession(id: number): Promise<{ id: number }> {
  // Use soft-cancel: keeps history, frees the slot via the `status='active'` filter.
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE sessions SET status = 'cancelled' WHERE id = $1 AND status = 'active' RETURNING id`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new DomainError('SESSION_NOT_FOUND', `Session ${id} not found or already cancelled`);
  return { id: Number(r.id) };
}
