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
