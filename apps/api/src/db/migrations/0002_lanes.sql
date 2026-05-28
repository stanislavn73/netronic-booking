-- =============================================================================
-- 0002_lanes.sql — retire the advisory lock; let Postgres enforce the cap.
--
-- See 0002_lanes.NOTES.md for the full design rationale, app code change
-- plan, retry strategy, and rollout. This file is the DDL only.
--
-- Summary:
--   1. Add a SMALLINT `lane` column (1..ARENA_CAPACITY).
--   2. Backfill via greedy lane assignment, ordered by lower(during) per
--      arena. Fails loudly if any arena already exceeds 5 concurrent at
--      any instant (would mean prior data violated the spec).
--   3. Add EXCLUDE constraint on (arena_id, lane, during) so concurrent
--      writes can no longer exceed the cap — Postgres rejects any INSERT
--      that would overlap an existing active session on the same lane.
--   4. Drop the old partial GiST index — the EXCLUDE creates its own.
--
-- After this migration, createSession's advisory lock becomes obsolete:
--   • Atomic lane pick: a single INSERT … SELECT FROM generate_series(1,5)
--     finds the first lane with no overlap.
--   • Race-safe: if two transactions pick the same lane, the second's
--     INSERT raises 23P03 (exclusion_violation). App retries with the
--     next-available lane; after 5 retries, arena is genuinely full.
-- =============================================================================

-- btree_gist is already loaded by 0001 — required for the smallint WITH =
-- clause inside the GiST EXCLUDE.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS lane SMALLINT;

-- ---------------------------------------------------------------------------
-- Greedy backfill: walk sessions ordered by (arena_id, lower(during), id),
-- track the next-free time on each of the 5 lanes, place each session on the
-- first lane that's free at its start. O(N) per arena.
--
-- Raises if a row cannot fit — that would mean existing data already
-- violated the ≤5 concurrent rule, which is a data bug, not a migration
-- bug. The transaction rolls back and the operator investigates.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rec        RECORD;
  lane_ends  TIMESTAMPTZ[] := ARRAY[NULL, NULL, NULL, NULL, NULL]::TIMESTAMPTZ[];
  arena_cur  BIGINT := NULL;
  picked     SMALLINT;
  i          INT;
BEGIN
  FOR rec IN
    SELECT id, arena_id, lower(during) AS s, upper(during) AS e
    FROM sessions
    WHERE status = 'active' AND lane IS NULL
    ORDER BY arena_id, lower(during), id
  LOOP
    IF arena_cur IS DISTINCT FROM rec.arena_id THEN
      lane_ends := ARRAY[NULL, NULL, NULL, NULL, NULL]::TIMESTAMPTZ[];
      arena_cur := rec.arena_id;
    END IF;
    picked := NULL;
    FOR i IN 1..5 LOOP
      IF lane_ends[i] IS NULL OR lane_ends[i] <= rec.s THEN
        picked := i;
        lane_ends[i] := rec.e;
        EXIT;
      END IF;
    END LOOP;
    IF picked IS NULL THEN
      RAISE EXCEPTION
        'Cannot fit session % (arena %, start %) into 5 lanes — existing data violates the cap',
        rec.id, rec.arena_id, rec.s;
    END IF;
    UPDATE sessions SET lane = picked WHERE id = rec.id;
  END LOOP;
END $$;

-- Cancelled rows may still have NULL lane. Assign 1 (arbitrary — they're
-- excluded from the EXCLUDE WHERE clause and never participate in cap math).
UPDATE sessions SET lane = 1 WHERE lane IS NULL;

ALTER TABLE sessions
  ALTER COLUMN lane SET NOT NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_lane_in_range
    CHECK (lane BETWEEN 1 AND 5);

-- The killer constraint. Two active sessions in the same arena cannot
-- share the same lane and overlap in time. Concurrent INSERTs that race
-- to the same lane are rejected with SQLSTATE 23P03.
ALTER TABLE sessions
  ADD CONSTRAINT sessions_no_lane_overlap
    EXCLUDE USING GIST (arena_id WITH =, lane WITH =, during WITH &&)
    WHERE (status = 'active');

-- The 0001 partial GiST on (arena_id, during) is now redundant — the
-- EXCLUDE constraint creates an equivalent index. Drop it to avoid double
-- write amplification on INSERT/UPDATE.
DROP INDEX IF EXISTS sessions_arena_during_gist;

-- The btree on (arena_id, lower(during)) still pays for read paths that
-- order by start (sessionsByArena), so we keep it.
