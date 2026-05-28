# 0002_lanes — design notes

Review checklist before approving `sessions.ts` rewrite.

## Why

The advisory lock in `withArenaLock` was the only thing keeping the 5-cap
honest across concurrent writes. It works but pays:

- Round-trip per `createSession` to take and release the lock.
- All writes for one arena serialize on one Postgres backend regardless of
  whether they'd actually conflict.
- The cap rule is enforced **only** in application code — schema does not
  prevent a buggy migration / direct INSERT from violating it.

EXCLUDE constraints push the enforcement into Postgres, so the DB is the
source of truth. The advisory lock disappears.

## What the migration does

1. `ADD COLUMN lane SMALLINT` (nullable initially so backfill can write it).
2. Backfill via a `DO $$ … $$;` block: greedy lane assignment per arena,
   sessions ordered by `lower(during)`. Each session takes the first lane
   whose previous end is `<= start`. Fails loudly if any row can't fit.
3. `ALTER COLUMN lane SET NOT NULL`, `CHECK (lane BETWEEN 1 AND 5)`.
4. `EXCLUDE USING GIST (arena_id WITH =, lane WITH =, during WITH &&)
   WHERE (status = 'active')` — the schema-level cap.
5. Drop the now-redundant `sessions_arena_during_gist` partial index.

## Backfill characteristics

- O(N) per arena. PL/pgSQL row-by-row UPDATE → slow at the 100M-row seed
  scale (~10 min on commodity hardware). For real prod with that volume
  you'd want a chunked, resumable script; for our dev/seed sizes it's
  fine.
- Existing data **must** already satisfy the cap (seed guarantees this).
  If a real-world dataset violated it, the migration raises and rolls
  back — preferable to silent data loss.
- Cancelled rows get `lane = 1` arbitrarily; the EXCLUDE `WHERE
  status = 'active'` makes them invisible to the constraint.

## App code changes that follow (NOT in this migration)

### `db/sessions.repo.ts`

`insertActiveSession` becomes an atomic-pick-a-lane statement:

```sql
INSERT INTO sessions (arena_id, lane, during, player_name, status)
SELECT $1, lane, $2::tstzrange, $3, 'active'
FROM generate_series(1, 5) AS lane
WHERE NOT EXISTS (
  SELECT 1 FROM sessions s
  WHERE s.arena_id = $1 AND s.lane = lane
    AND s.status = 'active' AND s.during && $2::tstzrange
)
ORDER BY lane
LIMIT 1
RETURNING <SESSION_COLS>;
```

- 0 rows returned → cap reached → caller throws `SLOT_UNAVAILABLE`.
- 1 row returned → success.
- `23P03` (exclusion_violation) on this exact constraint → race; another
  txn took the lane between our SELECT and our INSERT — caller retries
  the whole INSERT. After 5 consecutive 23P03s the arena is genuinely
  full → throw `SLOT_UNAVAILABLE`.

`updateSessionRow` gets the same treatment when `(start, end)` changes:
re-run the pick-a-lane logic, set `lane` to the new pick.

### `services/sessions.ts`

- `createSession`: drop `withArenaLock`. Wrap the INSERT in a retry loop
  catching `error.code === '23P03' && error.constraint ===
  'sessions_no_lane_overlap'`. Probe for `fillsUpAt` and
  `maxAvailableDurationMinutes` only on the final SLOT_UNAVAILABLE path so
  the happy path is one round-trip.
- `updateSession`: same retry loop. The within-lock re-read goes away.
- `checkAvailability`: no change — it's read-only, no lock needed today.
- `probeConcurrency` and `maxAvailableDurationMs` stay; they're still
  needed for `checkAvailability` and for the meta on SLOT_UNAVAILABLE.

### `db/transactions.ts`

- `withTransaction` stays (still used for multi-statement reads, future
  bulk inserts).
- `withArenaLock` and `lockArena` become unused. Delete or keep for
  future ad-hoc serialization? **Recommend: delete** — keeping unused
  primitives invites accidental misuse.

### Tests

- `tests/race.test.ts`:
  - "exactly 5 of 20 concurrent identical-slot creates succeed" — passes
    unchanged. EXCLUDE serializes them at the DB.
  - "updateSession is serialized" — passes; same EXCLUDE machinery.
  - "max-concurrent not total-touched (8-of-5 regression)" — still
    relevant for `checkAvailability` and the SLOT_UNAVAILABLE meta. Keep.
  - "touching is not overlap (5 ending + 5 starting at 11:00)" — passes;
    same tstzrange `&&` semantics.
- `tests/overlap.test.ts` — unchanged.
- Add `tests/lane-assign.test.ts` (integration) — assert that 5 concurrent
  identical creates produce sessions with lane = 1..5 (not necessarily in
  order, but the set must be {1,2,3,4,5}).
- Add `tests/lane-retry.test.ts` — mock the first INSERT to throw 23P03,
  assert retry path succeeds with a different lane.

## Rollout

1. Land migration + repo + service changes in **one PR**. EXCLUDE without
   the new INSERT statement breaks every write. Don't half-deploy.
2. The migration adds an index; on a large prod DB this takes minutes and
   blocks writes. Use `CREATE INDEX CONCURRENTLY` + `ADD CONSTRAINT …
   USING INDEX` if production-scale (skipped here — dev seed is small).
3. Roll back: drop the EXCLUDE, drop the column, restore the old GiST
   index from 0001. Document this as `0003_revert_lanes.sql` ready to go.

## Open question

`lane` is server-only by default. Two options for the UI:

- **Keep server-only.** UI's `Timeline/lanes.ts` continues assigning
  visual lanes from `startTime` overlaps. Simple, no schema change.
- **Expose via `SessionFields`.** Add `lane: Int!` to the fragment;
  Timeline reads it directly; drop `Timeline/lanes.ts`. Less drift, but
  ties UI to the cap implementation.

Recommend: keep server-only for the first PR. Revisit when the UI audit
happens.
