/**
 * Seed script — generates realistic, cap-respecting test data via COPY FROM STDIN.
 *
 * Why COPY, not INSERT: 100K+ row INSERTs through the wire are dog-slow even in
 * batches. COPY is 50-100x faster and is what you'd reach for in any real
 * data-import job.
 *
 * Why "5 parallel lanes" per arena: it guarantees the generated data NEVER
 * violates the ≤5 concurrent rule, regardless of distribution. Each lane is
 * an independent serial sequence of sessions — guaranteed no overlap within
 * a lane — and we have exactly 5 lanes per arena. Done.
 *
 * Configuration via env vars:
 *   ARENAS  — number of arenas (default: 100)
 *   YEARS   — span of data to generate, centered on today (default: 1)
 *   LANES   — concurrent capacity per arena (default: 5)
 *   AVG_MIN — target average session length in minutes (default: 60)
 *
 * For the full spec scale (1000 arenas × 5 years), set ARENAS=1000 YEARS=5.
 * Expect ~100M rows and 10-20 minutes on commodity hardware.
 */
import pgCopyStreams from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pool } from '../src/db/index.js';

const { from: copyFrom } = pgCopyStreams;

const ARENAS = Number(process.env.ARENAS ?? 100);
const YEARS = Number(process.env.YEARS ?? 1);
const LANES = Number(process.env.LANES ?? 5);
const AVG_MIN = Number(process.env.AVG_MIN ?? 60);

const MS_MIN = 60_000;

// PRNG so seeds are reproducible.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmt(d: Date): string {
  // ISO-8601 with explicit UTC offset. Postgres tstzrange parsing accepts the T
  // separator and Z timezone; keeping them avoids any string-mangling risk.
  return d.toISOString();
}

async function seedArenas(): Promise<number[]> {
  console.log(`Seeding ${ARENAS} arenas...`);
  const client = await pool.connect();
  try {
    await client.query('TRUNCATE arenas, sessions RESTART IDENTITY CASCADE');
    const stream = client.query(copyFrom('COPY arenas (name) FROM STDIN'));
    const src = Readable.from(
      (function* () {
        for (let i = 1; i <= ARENAS; i++) yield `Arena #${i}\n`;
      })(),
    );
    await pipeline(src, stream);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM arenas ORDER BY id');
    return rows.map((r) => Number(r.id));
  } finally {
    client.release();
  }
}

function* sessionRowsForArena(
  arenaId: number,
  rand: () => number,
  startWindow: Date,
  endWindow: Date,
): Generator<string> {
  // For each of LANES independent lanes, walk forward filling time.
  for (let lane = 0; lane < LANES; lane++) {
    let cursor = startWindow.getTime() + Math.floor(rand() * 30 * MS_MIN); // small jitter
    while (cursor < endWindow.getTime()) {
      // Duration: 5 min .. 24h, mean ≈ AVG_MIN, skewed.
      const durMin = Math.max(5, Math.min(24 * 60, Math.floor(-Math.log(1 - rand()) * AVG_MIN)));
      const endMs = cursor + durMin * MS_MIN;
      if (endMs > endWindow.getTime()) break;
      const start = new Date(cursor);
      const end = new Date(endMs);
      // tstzrange literal embedded in a CSV-quoted column. The CSV format COPY
      // expects: each column tab-separated, newline at end, no header.
      // We use text format with explicit tab delimiter, quoting the range.
      yield `${arenaId}\t[${fmt(start)},${fmt(end)})\t\\N\tactive\n`;

      // Small inter-session gap, occasionally touching exactly (gap = 0).
      const gapMin = rand() < 0.2 ? 0 : Math.floor(rand() * 15);
      cursor = endMs + gapMin * MS_MIN;
    }
  }
}

async function seedSessions(arenaIds: number[]) {
  const now = Date.now();
  const halfSpan = (YEARS * 365 * 24 * 3600 * 1000) / 2;
  const startWindow = new Date(now - halfSpan);
  const endWindow = new Date(now + halfSpan);

  console.log(
    `Seeding sessions: ${arenaIds.length} arenas × ${LANES} lanes × ${YEARS}y window ` +
      `(${startWindow.toISOString().slice(0, 10)} → ${endWindow.toISOString().slice(0, 10)})`,
  );

  const client = await pool.connect();
  try {
    const stream = client.query(
      copyFrom(`COPY sessions (arena_id, during, player_name, status) FROM STDIN`),
    );
    const src = Readable.from(
      (function* () {
        let count = 0;
        const t0 = Date.now();
        for (const arenaId of arenaIds) {
          const rand = mulberry32(arenaId * 2654435761);
          for (const row of sessionRowsForArena(arenaId, rand, startWindow, endWindow)) {
            yield row;
            count++;
            if (count % 100_000 === 0) {
              const rate = Math.round(count / ((Date.now() - t0) / 1000));
              process.stderr.write(`  ${count.toLocaleString()} rows (${rate}/s)\n`);
            }
          }
        }
        process.stderr.write(`  total: ${count.toLocaleString()} rows\n`);
      })(),
    );
    await pipeline(src, stream);

    console.log('Running ANALYZE...');
    await client.query('ANALYZE arenas');
    await client.query('ANALYZE sessions');
  } finally {
    client.release();
  }
}

async function main() {
  const t0 = Date.now();
  const arenaIds = await seedArenas();
  await seedSessions(arenaIds);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
