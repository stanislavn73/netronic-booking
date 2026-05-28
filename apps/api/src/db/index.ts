import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

const { Pool } = pg;

/**
 * SSL for managed Postgres (Neon, Supabase, Render, Fly.io). These providers
 * end their connection strings with `sslmode=require`, but node-postgres
 * does NOT pick that up from the URL — `ssl` has to be passed explicitly.
 *
 * `rejectUnauthorized: false` accepts the provider's CA without bundling it.
 * That's fine for in-transit encryption (we're already authenticated by the
 * credentials in the URL); for stricter setups, ship the provider's CA
 * cert and use `ca: fs.readFileSync(...)` instead.
 *
 * Off in dev so the local Docker Postgres (no cert) works untouched.
 */
const ssl = env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  // Allow long-running seed transactions
  statement_timeout: env.NODE_ENV === 'production' ? 30_000 : 0,
  ssl,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
