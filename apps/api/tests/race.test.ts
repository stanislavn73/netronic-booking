/**
 * Integration test for the core concurrency claim:
 *
 *   "If two users simultaneously create a session for the same arena, the
 *    system MUST NOT exceed the 5-concurrent-sessions limit."
 *
 * Strategy: connect to the dev Postgres (the one you started with `make up`),
 * create a fresh, isolated database for this test run, apply the migration,
 * run the tests, drop the database in afterAll.
 *
 * Prerequisites: `make up` (the dev Postgres on port 5433 must be running).
 * We do NOT use testcontainers because:
 *   1. testcontainers on macOS has known issues with the Ryuk sidecar and
 *      port-binding resolution ("No host port found for host IP").
 *   2. Using the dev Postgres is faster (no container startup), and isolation
 *      via a per-run database is just as strong as a per-run container.
 *
 * If you want to switch back to testcontainers, replace beforeAll/afterAll
 * with PostgreSqlContainer.start()/stop() — the test bodies don't change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, '..', 'src', 'db', 'migrations', '0001_init.sql');

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://booking:booking@localhost:5433/postgres';

const TEST_DB_NAME = `booking_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  try {
    // 1. Create an isolated test database on the dev Postgres.
    await withAdminClient(async (admin) => {
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    });

    const testUrl = ADMIN_URL.replace(/\/postgres(\?|$)/, `/${TEST_DB_NAME}$1`);
    process.env.DATABASE_URL = testUrl;
    // eslint-disable-next-line no-console
    console.log('[race-test] using test DB:', testUrl);

    // 2. Apply the migration on the freshly-created DB.
    const sql = await readFile(MIGRATION, 'utf8');
    const { pool } = await import('../src/db/index.js');
    await pool.query(sql);
    await pool.query("INSERT INTO arenas (id, name) VALUES (1, 'Test Arena')");
    await pool.query("SELECT setval('arenas_id_seq', 1, true)");
    // eslint-disable-next-line no-console
    console.log('[race-test] schema applied, arena seeded');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[race-test] beforeAll FAILED:', err);
    // Clean up the orphaned DB if we created it.
    await withAdminClient(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    }).catch(() => undefined);
    throw err;
  }
}, 60_000);

afterAll(async () => {
  try {
    const { pool } = await import('../src/db/index.js');
    await pool.end();
  } catch {
    /* ignore */
  }

  // Drop the test DB. Force-disconnect any lingering sessions first.
  await withAdminClient(async (admin) => {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[race-test] cleanup failed (DB may be left behind):', err.message);
  });
}, 30_000);

describe('race conditions on the 5-concurrent cap', () => {
  it('exactly 5 of 20 concurrent identical-slot creates succeed', async () => {
    const { createSession } = await import('../src/services/sessions.js');
    const { DomainError } = await import('../src/services/errors.js');

    const start = new Date('2030-01-01T10:00:00Z');
    const end = new Date('2030-01-01T11:00:00Z');

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        createSession({ arenaId: 1, startTime: start, endTime: end }),
      ),
    );

    const succeeded = settled.filter((r) => r.status === 'fulfilled');
    const slotUnavailable = settled.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof DomainError &&
        r.reason.code === 'SLOT_UNAVAILABLE',
    );
    const unexpected = settled.filter(
      (r) =>
        r.status === 'rejected' &&
        !(r.reason instanceof DomainError && r.reason.code === 'SLOT_UNAVAILABLE'),
    );

    if (unexpected.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[race-test] unexpected rejections:',
        unexpected.slice(0, 5).map((r) => {
          const reason = (r as PromiseRejectedResult).reason;
          return {
            name: reason?.name,
            code: reason?.code,
            message: reason?.message,
            stack: reason?.stack?.split('\n').slice(0, 4).join('\n'),
          };
        }),
      );
    }

    const outcome = {
      succeeded: succeeded.length,
      slotUnavailable: slotUnavailable.length,
      unexpected: unexpected.length,
    };
    // eslint-disable-next-line no-console
    console.log('[race-test] 20-way concurrent outcome:', outcome);
    expect(outcome).toEqual({ succeeded: 5, slotUnavailable: 15, unexpected: 0 });
  }, 60_000);

  it('updateSession is serialized by the same lock — only 1 of N concurrent updates into a near-full window succeeds', async () => {
    // SETUP:
    //   Window A (10:00–11:00) has 4 active sessions, leaving room for exactly 1 more.
    //   Outside A we create 10 "candidate" sessions at non-overlapping later times.
    //   We then fire 10 concurrent updateSession calls trying to MOVE each
    //   candidate into A. Only one should succeed — the rest must see
    //   SLOT_UNAVAILABLE.
    //
    //   This proves the per-arena advisory lock guards updates the same way
    //   it guards creates. Before this test existed, the create-side race
    //   test would have stayed green even if the update path had a TOCTOU
    //   race introduced.
    const { createSession, updateSession } = await import('../src/services/sessions.js');
    const { DomainError } = await import('../src/services/errors.js');
    const { pool } = await import('../src/db/index.js');

    await pool.query('TRUNCATE sessions RESTART IDENTITY');

    const targetStart = new Date('2030-03-01T10:00:00Z');
    const targetEnd = new Date('2030-03-01T11:00:00Z');
    // 4 sessions in the target window — leaves capacity for exactly 1 more.
    for (let i = 0; i < 4; i++) {
      await createSession({ arenaId: 1, startTime: targetStart, endTime: targetEnd });
    }

    // 10 candidates at later, non-overlapping times so each starts in a valid slot.
    const candidates: number[] = [];
    for (let i = 0; i < 10; i++) {
      const candStart = new Date('2030-03-01T13:00:00Z');
      candStart.setUTCMinutes(i * 6); // 13:00, 13:06, 13:12 … none overlap
      const candEnd = new Date(candStart.getTime() + 5 * 60_000);
      const s = await createSession({ arenaId: 1, startTime: candStart, endTime: candEnd });
      candidates.push(s.id);
    }

    // Fire all 10 updates concurrently, each trying to move its candidate
    // into the now-near-full target window.
    const settled = await Promise.allSettled(
      candidates.map((id) =>
        updateSession(id, { startTime: targetStart, endTime: targetEnd }),
      ),
    );

    const succeeded = settled.filter((r) => r.status === 'fulfilled');
    const slotUnavailable = settled.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof DomainError &&
        r.reason.code === 'SLOT_UNAVAILABLE',
    );
    const unexpected = settled.filter(
      (r) =>
        r.status === 'rejected' &&
        !(r.reason instanceof DomainError && r.reason.code === 'SLOT_UNAVAILABLE'),
    );

    if (unexpected.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[race-test:update] unexpected rejections:',
        unexpected.slice(0, 5).map((r) => {
          const reason = (r as PromiseRejectedResult).reason;
          return {
            name: reason?.name,
            code: reason?.code,
            message: reason?.message,
          };
        }),
      );
    }

    // Exactly 1 update made it into the target window; the other 9 were rejected.
    expect({
      succeeded: succeeded.length,
      slotUnavailable: slotUnavailable.length,
      unexpected: unexpected.length,
    }).toEqual({ succeeded: 1, slotUnavailable: 9, unexpected: 0 });

    // Sanity: the target window must now hold exactly 5 active sessions, never 6.
    const { rows } = await pool.query<{ c: string }>(
      `
      SELECT COUNT(*)::text AS c
      FROM sessions
      WHERE arena_id = 1
        AND status = 'active'
        AND during && tstzrange($1::timestamptz, $2::timestamptz, '[)')
      `,
      [targetStart.toISOString(), targetEnd.toISOString()],
    );
    expect(Number(rows[0]?.c ?? 0)).toBe(5);
  }, 60_000);

  it('cap check uses MAX-CONCURRENT, not total touched (regression: "8 of 5" prod bug)', async () => {
    // The bug: createSession used to call countOverlapping which returned the
    //   total number of sessions whose range overlapped the requested window.
    //   For long proposals in dense arenas, that count routinely exceeded 5
    //   even when no instant within the window had more than 5 concurrent.
    //
    // The fix: the service now computes max-concurrent via a sweep over events
    //   clipped to the proposed window. This test pins that behaviour by
    //   constructing a scenario where total-touched > 5 but max-concurrent ≤ 4
    //   and asserts that a long proposal at the same window SUCCEEDS.
    const { createSession } = await import('../src/services/sessions.js');
    const { pool } = await import('../src/db/index.js');

    await pool.query('TRUNCATE sessions RESTART IDENTITY');

    // Three sessions spanning the entire [10:00, 13:00) window — lanes A, B, C.
    for (let i = 0; i < 3; i++) {
      await createSession({
        arenaId: 1,
        startTime: new Date('2030-04-01T10:00:00Z'),
        endTime: new Date('2030-04-01T13:00:00Z'),
      });
    }
    // Three back-to-back short sessions in lane D filling that same window.
    await createSession({
      arenaId: 1,
      startTime: new Date('2030-04-01T10:00:00Z'),
      endTime: new Date('2030-04-01T11:00:00Z'),
    });
    await createSession({
      arenaId: 1,
      startTime: new Date('2030-04-01T11:00:00Z'),
      endTime: new Date('2030-04-01T12:00:00Z'),
    });
    await createSession({
      arenaId: 1,
      startTime: new Date('2030-04-01T12:00:00Z'),
      endTime: new Date('2030-04-01T13:00:00Z'),
    });

    // 6 sessions all touch [10:00, 13:00) — total-overlap COUNT is 6.
    // But at any instant within the window, max-concurrent is 4 (3 lanes
    // running long + 1 lane running a short, touching-not-overlapping pair
    // counts as one because of half-open semantics). Adding a 5th lane (the
    // proposal) brings concurrent to 5 → exactly at cap, allowed.
    const result = await createSession({
      arenaId: 1,
      startTime: new Date('2030-04-01T10:00:00Z'),
      endTime: new Date('2030-04-01T13:00:00Z'),
    });

    expect(result.id).toBeGreaterThan(0);

    // Now we're full — a 5th lane already exists. A SIXTH long proposal
    // for the same window must hit max-concurrent = 5 and be rejected.
    await expect(
      createSession({
        arenaId: 1,
        startTime: new Date('2030-04-01T10:00:00Z'),
        endTime: new Date('2030-04-01T13:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  }, 60_000);

  it('the "touching is not overlap" rule holds (5 ending at 11:00 + 5 starting at 11:00)', async () => {
    const { createSession, sessionsByArena } = await import('../src/services/sessions.js');
    const { pool } = await import('../src/db/index.js');

    await pool.query('TRUNCATE sessions RESTART IDENTITY');

    const ending = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createSession({
          arenaId: 1,
          startTime: new Date('2030-02-01T10:00:00Z'),
          endTime: new Date('2030-02-01T11:00:00Z'),
        }),
      ),
    );
    expect(ending.filter((r) => r.status === 'fulfilled').length).toBe(5);

    const starting = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createSession({
          arenaId: 1,
          startTime: new Date('2030-02-01T11:00:00Z'),
          endTime: new Date('2030-02-01T12:00:00Z'),
        }),
      ),
    );
    expect(starting.filter((r) => r.status === 'fulfilled').length).toBe(5);

    const all = await sessionsByArena(
      1,
      new Date('2030-02-01T09:00:00Z'),
      new Date('2030-02-01T13:00:00Z'),
    );
    // eslint-disable-next-line no-console
    console.log(
      '[race-test] touching-boundary sessions stored:',
      all.map((s) => `${s.startTime.toISOString()}→${s.endTime.toISOString()}`),
    );
    expect(all.length).toBe(10);
  }, 60_000);
});
