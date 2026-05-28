-- =============================================================================
-- 0001_init.sql — Arenas & Sessions
--
-- Design notes (the "why"):
--
-- 1. `during TSTZRANGE` with [) bounds. Half-open intervals make the spec's
--    "touching is not overlap" rule work for free against Postgres's && operator.
--    Storing start_time + duration (or start + end as two columns) is wrong here.
--
-- 2. `btree_gist` extension + GiST index on `(arena_id, during)`. A plain GiST
--    on `during` alone cannot prefix-filter by arena. btree_gist lets us mix
--    the scalar arena_id with the range column inside the same operator class.
--
-- 3. CHECK constraints enforce business rules at the DB. Application code is
--    not the source of truth here; the DB is.
--
-- 4. We do NOT add an EXCLUDE constraint that forbids any overlap — the spec
--    allows up to 5 concurrent sessions. The 5-cap is enforced by application
--    logic running under a per-arena advisory lock (see services/sessions.ts).
--    See README "Concurrency" for the trade-off analysis.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS arenas (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           BIGSERIAL PRIMARY KEY,
  arena_id     BIGINT NOT NULL REFERENCES arenas(id) ON DELETE CASCADE,
  during       TSTZRANGE NOT NULL,
  player_name  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sessions_during_not_empty
    CHECK (NOT isempty(during)),

  CONSTRAINT sessions_during_bounded
    CHECK (lower(during) IS NOT NULL AND upper(during) IS NOT NULL),

  -- Half-open canonical form: [) — closed at start, open at end.
  CONSTRAINT sessions_during_half_open
    CHECK (lower_inc(during) AND NOT upper_inc(during)),

  CONSTRAINT sessions_min_duration_5min
    CHECK (upper(during) - lower(during) >= interval '5 minutes'),

  CONSTRAINT sessions_max_duration_24h
    CHECK (upper(during) - lower(during) <= interval '24 hours'),

  CONSTRAINT sessions_status_valid
    CHECK (status IN ('active', 'cancelled'))
);

-- The killer index: GiST on (arena_id, during) supports filtered overlap queries.
-- All hot-path queries — overlap check on write, "sessions for arena X on date Y",
-- slot suggestion sweep — hit this index.
CREATE INDEX IF NOT EXISTS sessions_arena_during_gist
  ON sessions USING GIST (arena_id, during)
  WHERE status = 'active';

-- Secondary index for ordered listing by start time within an arena.
-- Used by sessionsByArena queries that order by start.
CREATE INDEX IF NOT EXISTS sessions_arena_start_btree
  ON sessions (arena_id, (lower(during)))
  WHERE status = 'active';

-- updated_at maintenance — automatic, so application code can't forget.
CREATE OR REPLACE FUNCTION sessions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sessions_touch_updated_at ON sessions;
CREATE TRIGGER sessions_touch_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_touch_updated_at();
