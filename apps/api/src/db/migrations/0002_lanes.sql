-- =============================================================================
-- 0002_lanes.sql — phased rollout, step 1 of 2: add `lane` column.
--
-- This step is deliberately tiny. The prior version of this migration tried
-- to backfill ~2M rows inside the same transaction via PL/pgSQL row-by-row
-- UPDATE, which exceeded Render's startup health-check window. Container
-- crashed at boot, Render kept serving the previous deploy, schema never
-- changed. See 0002_lanes.NOTES.md for the full phased rollout.
--
-- This step only adds the column (nullable). No backfill. No constraint.
-- That keeps the migration O(milliseconds) regardless of table size.
--
-- After this deploys, run `pnpm --filter @app/api backfill:lanes` from your
-- laptop. That's a separately-checked-in script that assigns lanes in
-- batches with explicit COMMITs so it can be interrupted and resumed.
--
-- The matching constraint (`SET NOT NULL` + EXCLUDE) lands in 0003 ONCE
-- the backfill has been run to completion. Don't add 0003 to this PR.
-- =============================================================================

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS lane SMALLINT;
