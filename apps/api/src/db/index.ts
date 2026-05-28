import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  // Allow long-running seed transactions
  statement_timeout: env.NODE_ENV === 'production' ? 30_000 : 0,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
