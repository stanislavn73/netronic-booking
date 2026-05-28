/**
 * Plain SQL migrator — applies every *.sql file in src/db/migrations in
 * lexicographic order, recording applied filenames in `schema_migrations`.
 *
 * We deliberately do NOT use drizzle-kit's migrator because our migration
 * uses Postgres-specific DDL (tstzrange, btree_gist, GiST) that drizzle-kit
 * doesn't introspect or generate. Owning the SQL keeps it honest.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations'
  );
  return new Set(rows.map((r) => r.filename));
}

async function main() {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`✓ ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ ${file} (applied)`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ ${file} FAILED:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`\n${count} migration(s) applied. ${applied.size + count} total.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
