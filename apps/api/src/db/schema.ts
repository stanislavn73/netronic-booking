/**
 * Drizzle schema — declarative typing for arenas & sessions.
 *
 * NOTE: Drizzle doesn't natively model tstzrange. We declare `during` as a
 * customType so Drizzle treats it as opaque; reads/writes go through helpers
 * in src/db/range.ts. The actual range column + GiST index + CHECK constraints
 * are created by the raw SQL migration in migrations/0001_init.sql.
 *
 * This is deliberate: Postgres-native features (range types, GiST, EXCLUDE,
 * advisory locks, btree_gist) are the whole point of choosing Postgres for
 * this workload. We don't fight the ORM — we use it where it shines (typed
 * SELECTs, INSERT helpers) and bypass it where it doesn't (DDL, range ops).
 */
import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  customType,
} from 'drizzle-orm/pg-core';

// tstzrange as opaque text; we always serialize/deserialize via range helpers.
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const arenas = pgTable('arenas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  arenaId: bigint('arena_id', { mode: 'number' }).notNull().references(() => arenas.id),
  during: tstzrange('during').notNull(),
  playerName: text('player_name'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Arena = typeof arenas.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
