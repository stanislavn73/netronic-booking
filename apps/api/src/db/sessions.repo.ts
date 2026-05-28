/**
 * Sessions repository — pure SQL access for sessions and arenas.
 *
 * No business rules live here. Cap enforcement, validation, and locking
 * belong to `services/sessions.ts`.
 *
 * All overlap queries use `arena_id = $1 AND status = 'active' AND during &&
 * $2::tstzrange` so they hit the partial GiST index defined in
 * `migrations/0001_init.sql`.
 */
import type { Pool, PoolClient } from 'pg';
import { pool } from './index.js';
import { parseRange, rangeLiteral } from './range.js';
import type { Interval, Window } from './sweep.js';

type Q = Pool | PoolClient;

/**
 * Plain DTO returned by every read path. Mirrors {@link SessionRecord} in
 * services to avoid a circular import — services re-exports this as
 * `SessionRecord`.
 */
export interface SessionRow {
  id: number;
  arenaId: number;
  startTime: Date;
  endTime: Date;
  playerName: string | null;
  status: 'active' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const SESSION_COLS = `id, arena_id, during::text AS during, player_name, status, created_at, updated_at`;

interface RawRow {
  id: string | number;
  arena_id: string | number;
  during: string;
  player_name: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(r: RawRow): SessionRow {
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

/** `true` iff the arena exists. */
export async function arenaExists(q: Q, arenaId: number): Promise<boolean> {
  const { rowCount } = await q.query('SELECT 1 FROM arenas WHERE id = $1', [arenaId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Active intervals for an arena that overlap `window`. Excludes `excludeId`
 * when given (used by update probes so a session doesn't count against itself).
 */
export async function selectActiveIntervals(
  q: Q,
  arenaId: number,
  window: Window,
  excludeId?: number,
): Promise<Interval[]> {
  const sql = `
    SELECT lower(during) AS s, upper(during) AS e
    FROM sessions
    WHERE arena_id = $1
      AND status = 'active'
      AND during && $2::tstzrange
      ${excludeId ? 'AND id <> $3' : ''}
  `;
  const params: unknown[] = [arenaId, rangeLiteral(window.start, window.end)];
  if (excludeId) params.push(excludeId);
  const { rows } = await q.query<{ s: Date; e: Date }>(sql, params);
  return rows.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
}

/** Active session rows overlapping `window`, ordered by start. */
export async function selectActiveSessions(
  q: Q,
  arenaId: number,
  window: Window,
): Promise<SessionRow[]> {
  const { rows } = await q.query<RawRow>(
    `SELECT ${SESSION_COLS}
     FROM sessions
     WHERE arena_id = $1
       AND status = 'active'
       AND during && $2::tstzrange
     ORDER BY lower(during) ASC`,
    [arenaId, rangeLiteral(window.start, window.end)],
  );
  return rows.map(rowToRecord);
}

/** Batched form for the per-request DataLoader. */
export async function selectActiveSessionsForArenas(
  q: Q,
  arenaIds: readonly number[],
  window: Window,
): Promise<Map<number, SessionRow[]>> {
  const grouped = new Map<number, SessionRow[]>(arenaIds.map((id) => [id, [] as SessionRow[]]));
  if (arenaIds.length === 0) return grouped;
  const { rows } = await q.query<RawRow>(
    `SELECT ${SESSION_COLS}
     FROM sessions
     WHERE arena_id = ANY($1::bigint[])
       AND status = 'active'
       AND during && $2::tstzrange
     ORDER BY arena_id, lower(during) ASC`,
    [arenaIds, rangeLiteral(window.start, window.end)],
  );
  for (const r of rows) {
    const rec = rowToRecord(r);
    grouped.get(rec.arenaId)!.push(rec);
  }
  return grouped;
}

/** Single row by primary key, or null. */
export async function selectSessionById(q: Q, id: number): Promise<SessionRow | null> {
  const { rows } = await q.query<RawRow>(
    `SELECT ${SESSION_COLS} FROM sessions WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Insert a new active session. Returns the inserted row. */
export async function insertActiveSession(
  q: Q,
  args: { arenaId: number; start: Date; end: Date; playerName: string | null },
): Promise<SessionRow> {
  const { rows } = await q.query<RawRow>(
    `INSERT INTO sessions (arena_id, during, player_name, status)
     VALUES ($1, $2::tstzrange, $3, 'active')
     RETURNING ${SESSION_COLS}`,
    [args.arenaId, rangeLiteral(args.start, args.end), args.playerName],
  );
  const row = rows[0];
  if (!row) throw new Error('INSERT did not return a row');
  return rowToRecord(row);
}

/** Update a session's window and playerName. Returns null if id doesn't exist. */
export async function updateSessionRow(
  q: Q,
  id: number,
  args: { start: Date; end: Date; playerName: string | null },
): Promise<SessionRow | null> {
  const { rows } = await q.query<RawRow>(
    `UPDATE sessions
     SET during = $2::tstzrange, player_name = $3
     WHERE id = $1
     RETURNING ${SESSION_COLS}`,
    [id, rangeLiteral(args.start, args.end), args.playerName],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Soft-cancel: status='cancelled'. Returns the id, or null if not active. */
export async function cancelSession(q: Q, id: number): Promise<number | null> {
  const { rows } = await q.query<{ id: string }>(
    `UPDATE sessions SET status = 'cancelled'
     WHERE id = $1 AND status = 'active' RETURNING id`,
    [id],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export interface ListArenasArgs {
  limit?: number;
  offset?: number;
  search?: string;
}

export interface ArenaRow {
  id: number;
  name: string;
  createdAt: Date;
}

/** Arena listing with optional name search (ILIKE), and bounded pagination. */
export async function listArenas(args: ListArenasArgs = {}): Promise<ArenaRow[]> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
  const offset = Math.max(args.offset ?? 0, 0);
  const search = args.search?.trim();
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

/** Single arena by id, or null. */
export async function getArenaById(id: number): Promise<ArenaRow | null> {
  const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>(
    'SELECT id, name, created_at FROM arenas WHERE id = $1',
    [id],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), name: r.name, createdAt: r.created_at } : null;
}
