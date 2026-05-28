/**
 * Transaction and advisory-lock helpers.
 *
 * Composable: callers can take a transaction without a lock, a lock inside
 * an existing transaction, or both at once via {@link withArenaLock}.
 */
import type { PoolClient } from 'pg';
import { pool } from './index.js';

/**
 * Run `fn` inside a BEGIN/COMMIT, releasing the client on success or
 * rollback on throw.
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
 * Acquire the per-arena `pg_advisory_xact_lock`. Auto-released on COMMIT or
 * ROLLBACK — only meaningful inside an open transaction.
 */
export async function lockArena(client: PoolClient, arenaId: number): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [String(arenaId)]);
}

/**
 * Transaction + per-arena advisory lock. Serializes writes for the same
 * arena without blocking writes to others, and without the row contention
 * of `SELECT FOR UPDATE` on the arena row.
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
