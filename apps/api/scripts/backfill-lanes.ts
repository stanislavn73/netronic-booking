/**
 * Backfill `lane` for existing active sessions.
 *
 * Greedy assignment per arena: walk sessions in `lower(during)` order and
 * place each on the first lane whose previous end is `<= start`. Computed
 * in JS, written back as a single bulk UPDATE per arena via VALUES list.
 *
 * **Runs outside the deploy pipeline.** Designed for Neon/Render at the
 * million-row scale where doing this inside `pnpm migrate`'s startup
 * timeout is infeasible. Invoke locally:
 *
 *     pnpm --filter @app/api backfill:lanes
 *
 * Properties:
 *   - Resumable: only touches rows where lane IS NULL. Crash → re-run.
 *   - Idempotent: re-running on a fully-backfilled DB is a no-op.
 *   - Bounded memory: streams arenas one at a time.
 *   - Fails loudly if any arena already exceeds 5 concurrent at any
 *     instant. Migration 0003 (NOT NULL + EXCLUDE) will then be unsafe
 *     until the data is corrected.
 */
import { pool } from '../src/db/index.js';

const LANES = 5;

interface SessionRow {
  id: number;
  s: Date;
  e: Date;
}

/**
 * Pure greedy assignment over a single arena's active sessions.
 * Returns a list of (id, lane) pairs in input order. Throws if a row
 * cannot fit into LANES lanes (existing data violates the cap).
 */
function assignLanes(arenaId: number, rows: SessionRow[]): Array<{ id: number; lane: number }> {
  const laneEnds: (Date | null)[] = Array.from({ length: LANES }, () => null);
  const out: Array<{ id: number; lane: number }> = [];
  for (const row of rows) {
    let picked: number | null = null;
    for (let i = 0; i < LANES; i++) {
      const end = laneEnds[i];
      if (!end || end.getTime() <= row.s.getTime()) {
        picked = i + 1;
        laneEnds[i] = row.e;
        break;
      }
    }
    if (picked === null) {
      throw new Error(
        `Cannot fit session ${row.id} into ${LANES} lanes for arena ${arenaId} at ${row.s.toISOString()} — existing data violates the cap`,
      );
    }
    out.push({ id: row.id, lane: picked });
  }
  return out;
}

/**
 * Bulk-update lanes for one arena via a single VALUES list. Limits to
 * ~5k rows per statement to keep memory and lock duration bounded.
 */
async function applyLanes(pairs: ReadonlyArray<{ id: number; lane: number }>) {
  const CHUNK = 5_000;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const values = chunk.map((_, k) => `($${2 * k + 1}::bigint, $${2 * k + 2}::smallint)`).join(',');
    const params = chunk.flatMap((p) => [p.id, p.lane]);
    await pool.query(
      `UPDATE sessions s SET lane = v.lane
       FROM (VALUES ${values}) AS v(id, lane)
       WHERE s.id = v.id`,
      params,
    );
  }
}

async function main() {
  const t0 = Date.now();

  // Snapshot of arenas with at least one unfilled row.
  const { rows: arenas } = await pool.query<{ arena_id: string; pending: string }>(
    `SELECT arena_id::text, COUNT(*)::text AS pending
     FROM sessions
     WHERE status = 'active' AND lane IS NULL
     GROUP BY arena_id
     ORDER BY arena_id`,
  );

  if (arenas.length === 0) {
    console.log('Nothing to backfill. All active sessions already have a lane.');
    await pool.end();
    return;
  }

  const totalPending = arenas.reduce((acc, a) => acc + Number(a.pending), 0);
  console.log(`Backfill plan: ${arenas.length} arenas, ${totalPending.toLocaleString()} rows.`);

  let done = 0;
  for (const { arena_id, pending } of arenas) {
    const arenaId = Number(arena_id);
    const { rows } = await pool.query<{ id: string; s: Date; e: Date }>(
      `SELECT id::text, lower(during) AS s, upper(during) AS e
       FROM sessions
       WHERE arena_id = $1 AND status = 'active' AND lane IS NULL
       ORDER BY lower(during), id`,
      [arenaId],
    );
    const sessionRows: SessionRow[] = rows.map((r) => ({
      id: Number(r.id),
      s: new Date(r.s),
      e: new Date(r.e),
    }));
    const pairs = assignLanes(arenaId, sessionRows);
    await applyLanes(pairs);
    done += pairs.length;
    const pct = ((done / totalPending) * 100).toFixed(1);
    const rate = Math.round(done / ((Date.now() - t0) / 1000));
    process.stdout.write(
      `  arena ${arenaId}: ${Number(pending).toLocaleString()} rows ✓  (${pct}% · ${rate.toLocaleString()}/s)\n`,
    );
  }

  // Cancelled rows with lane IS NULL get an arbitrary lane (1). They're
  // excluded from the EXCLUDE constraint's WHERE clause so the value
  // doesn't matter, but `SET NOT NULL` in 0003 needs them populated.
  const { rowCount: cancelled } = await pool.query(
    `UPDATE sessions SET lane = 1 WHERE lane IS NULL`,
  );
  console.log(`\nBackfilled ${done.toLocaleString()} active rows in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  if (cancelled) console.log(`Also set lane=1 on ${cancelled?.toLocaleString()} cancelled rows.`);
  console.log('Ready to apply 0003 (SET NOT NULL + EXCLUDE).');

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
