/**
 * Transaction + per-arena advisory-lock helpers.
 *
 * The lock guarantees write serialization within an arena so the
 * atomic-pick-a-lane INSERT can't race itself. Once migration 0003 lands
 * (EXCLUDE on `arena_id, lane, during`), Postgres becomes the source of
 * truth for the cap and the lock becomes belt-and-suspenders → can be
 * removed at that point.
 */
import type { PoolClient } from 'pg';
import { pool } from './index.js';

/**
 * Run `fn` inside BEGIN/COMMIT, releasing the client on success and
 * rolling back on throw.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

/**
 * Acquire `pg_advisory_xact_lock` keyed by `arenaId`. Auto-released on
 * COMMIT or ROLLBACK — only meaningful inside an open transaction.
 */
export async function lockArena(client: PoolClient, arenaId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [String(arenaId)]);
}

/**
 * Transaction + per-arena lock in one call. Serializes writes for the
 * same arena without blocking other arenas, and without the row
 * contention of `SELECT FOR UPDATE` on the arena row.
 */
export function withArenaLock<T>(
  arenaId: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await lockArena(client, arenaId);
    return fn(client);
  });
}
