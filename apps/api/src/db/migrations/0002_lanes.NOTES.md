# 0002_lanes — phased rollout

> **⛔️ SUPERSEDED / ABANDONED — do NOT apply step 2 (backfill) or step 3
> (0003 EXCLUDE).** This phased lane rollout was the *cause* of the
> production ">5 concurrent" regression, and the design is also subtly
> wrong even when completed. Cap enforcement is now done correctly by a
> max-concurrent sweep under the per-arena advisory lock — see
> `services/sessions.ts` (`assertHasRoom`). The `lane` column added by
> `0002_lanes.sql` is now **dormant**: it is written NULL, read by nothing,
> and kept only to avoid a needless `DROP COLUMN` on a large prod table.
>
> ### Why the lane model was abandoned
>
> 1. **It under-counted pre-existing rows → the actual prod bug.** The
>    enforcement INSERT picked a free lane via `NOT EXISTS (… s.lane =
>    g.lane …)`. The seed/COPY path (`scripts/seed.ts`) inserts rows with
>    NO lane, so `lane IS NULL`, and `NULL = g.lane` is never true. Every
>    seeded session was invisible to the check, so you could stack 5 *new*
>    sessions on top of an already-full window → 10 concurrent. Backfilling
>    would have masked this for seeded data, but any future NULL-lane write
>    path would reopen it.
> 2. **It over-restricts valid bookings even after backfill.** A fixed
>    greedy `(arena, lane)`-no-overlap EXCLUDE is interval *partitioning*,
>    not a "≤5 at any instant" cap. A long session whose window merely
>    touches five lanes' otherwise-disjoint short sessions is rejected even
>    though peak concurrency is 1 — violating the spec's "no excessive
>    restrictions" rule. A correct schema-level cap would need a sweep,
>    which a simple EXCLUDE cannot express.
>
> The original `paused-after-step-1` notes are kept below for history.
>
> ---
>
> **Status (historical): paused after step 1.** Step 1 (column-only 0002) is
> deployed. Steps 2–3 (backfill + EXCLUDE) were blocked on Neon free-tier
> storage being too tight to absorb a ~2M-row UPDATE's MVCC bloat. The file
> `0003_lane_constraints.sql.pending` is skipped by `scripts/migrate.ts`
> until renamed back to `.sql` — leave it parked.

The original single-shot 0002 (column + backfill + EXCLUDE in one migration)
proved unsafe at production scale on Render's free tier — the backfill
required a multi-million-row PL/pgSQL UPDATE inside one transaction, far
past the startup health-check window. The container exited, Render kept
the previous deploy serving traffic, schema never changed.

This is the safer phased version.

## Step 1 — `0002_lanes.sql` (lands in THIS PR)

DDL only. Adds `lane SMALLINT` (nullable). Idempotent.

Trivially fast — `ALTER TABLE` with no rewrite. Safe on any table size.

After this step:
- Schema has the `lane` column. No constraint yet.
- Existing rows have `lane = NULL`.
- New rows from `insertActiveSession` (rewritten in this PR) write a lane
  via the atomic-pick-a-lane INSERT statement.
- `withArenaLock` is still in place — it's the only race protection until
  the EXCLUDE constraint exists.

## Step 2 — `pnpm --filter @app/api backfill:lanes` (manual, post-deploy)

Greedy lane assignment for old rows that have `lane = NULL`. Run from your
laptop with `DATABASE_URL` pointing at production:

```bash
DATABASE_URL='postgres://…' pnpm --filter @app/api backfill:lanes
```

Properties:
- Streams arenas one at a time, fetches each arena's NULL-lane sessions in
  one query, computes lanes in JS, writes them back in 5000-row chunks via
  a single `UPDATE … FROM (VALUES …)` per chunk.
- Resumable: only touches `lane IS NULL`. Crash mid-flight → re-run picks
  up where it left off.
- Idempotent: re-running on a fully-backfilled DB processes 0 rows.
- Fails loudly if any arena exceeds 5 concurrent at any instant (existing
  data violates the spec) — step 3 will then be unsafe.

Estimated runtime on the seed-scale dataset (50 arenas × ~2M rows):
~3–8 minutes against Neon.

## Step 3 — `0003_lane_constraints.sql` (separate PR, after backfill verified)

```sql
ALTER TABLE sessions
  ALTER COLUMN lane SET NOT NULL,
  ADD CONSTRAINT sessions_lane_in_range CHECK (lane BETWEEN 1 AND 5),
  ADD CONSTRAINT sessions_no_lane_overlap
    EXCLUDE USING GIST (arena_id WITH =, lane WITH =, during WITH &&)
    WHERE (status = 'active');

DROP INDEX IF EXISTS sessions_arena_during_gist;
```

For multi-million-row tables, the `EXCLUDE` constraint build can take a
while. Prefer:

```sql
CREATE INDEX CONCURRENTLY sessions_no_lane_overlap_idx
  ON sessions USING GIST (arena_id, lane, during)
  WHERE status = 'active';

ALTER TABLE sessions
  ADD CONSTRAINT sessions_no_lane_overlap
    EXCLUDE USING GIST (arena_id WITH =, lane WITH =, during WITH &&)
    WHERE (status = 'active')
    USING INDEX sessions_no_lane_overlap_idx;
```

But `CREATE INDEX CONCURRENTLY` cannot run inside a transaction — the
current `scripts/migrate.ts` wraps every file in BEGIN/COMMIT. Either:
  a) Run the CONCURRENTLY step manually via psql, then commit a
     migration that only does the `ADD CONSTRAINT … USING INDEX` part; or
  b) Tolerate the brief table lock from a non-concurrent index build —
     acceptable during a known-low-traffic window.

## Step 4 — drop `withArenaLock` from `sessions.ts` (with step 3 or just after)

Once EXCLUDE is in place the lock is redundant. Replace with a 23P03
retry loop in the INSERT/UPDATE path:

```ts
const MAX_RETRIES = 5;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    return await insertActiveSession(pool, …);  // pool, not lock
  } catch (e) {
    if (isExclusionViolation(e, 'sessions_no_lane_overlap')) continue;
    throw e;
  }
}
throw slotUnavailable(…);
```

Where `isExclusionViolation` matches `error.code === '23P03'` and
`error.constraint === 'sessions_no_lane_overlap'`.

## Tests

- `tests/race.test.ts`:
  - "5 of 20 concurrent identical creates succeed" — passes after step 1
    via the advisory lock; after step 4 it passes via EXCLUDE.
  - "updateSession serialized" — same.
  - "max-concurrent regression" — still relevant because `probeConcurrency`
    is still called to populate the SLOT_UNAVAILABLE meta.
  - "touching is not overlap" — unchanged.
- `tests/overlap.test.ts` — unchanged.
- Add `tests/lane-assign.test.ts` after step 3 — confirm 5 simultaneous
  successful creates produce lanes {1,2,3,4,5}.

## Open question — exposing `lane` to the UI

Server-only by default. Two paths:
- **Keep server-only.** `apps/web/src/components/Timeline/lanes.ts` keeps
  its visual lane assignment.
- **Expose via `SessionFields`.** Add `lane: Int!` to the fragment, drop
  the client-side assignment. Cleaner but couples UI to cap implementation.

Decide when the web audit happens.
