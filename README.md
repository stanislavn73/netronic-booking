# Netronic — Arena Booking System

GraphQL API + React UI for scheduling game-arena sessions with a hard cap of
**5 concurrent sessions per arena**.

This README is a **design doc**, not just runbook. The architectural choices
are deliberate; the alternatives I rejected are listed with reasons. Read
sections 4–6 before you read the code.

---

## 1. Quickstart

Prerequisites: Docker (running), Node ≥ 20, pnpm ≥ 9.

Copy-paste this whole block in one go. It's safe to re-run any time — `make reset`
nukes the Postgres volume and rebuilds from scratch, so a stale `pgdata` from a
previous attempt won't bite you.

```bash
pnpm install
make reset
pnpm dev
```

That's the entire first-run sequence. Once it finishes (≈30 sec):

- GraphQL Sandbox: <http://localhost:4000/graphql>
- UI: <http://localhost:5173>

### What `make reset` actually does

It's just four commands wired together — paste these instead if you want them
explicit:

```bash
docker compose down -v
make up
make migrate
make seed
```

- `docker compose down -v` — stops Postgres and deletes the `pgdata` volume.
  The `-v` is critical: compose env vars (user/password/db) only initialize the
  DB on first volume creation, so re-using a stale volume gives the dreaded
  `role "booking" does not exist`.
- `make up` — starts Postgres 16 and waits for it to accept connections.
- `make migrate` — applies `apps/api/src/db/migrations/0001_init.sql`.
- `make seed` — generates 100 arenas × 1 year of dense bookings via
  `COPY FROM STDIN`. See "Seed scale" below to crank it up.

### Why Postgres is on port 5433, not 5432

Many machines have a native Postgres on 5432 (Homebrew, Postgres.app, etc.). To
avoid conflicts, the container maps to host port **5433**. The default
`DATABASE_URL` points there. If you want to use 5432 instead, edit
`docker-compose.yml` and `apps/api/.env.example` together.

### Day-to-day commands (after first run)

```bash
pnpm dev          # API on :4000, web on :5173
pnpm test         # unit + race-condition integration (requires `make up` first)
make down         # stop Postgres (keeps data)
make up           # bring Postgres back
```

The race-condition test creates a fresh isolated database on the dev Postgres
(`booking_test_<timestamp>`) and drops it on teardown — your dev data is untouched.

### End-to-end tests (Playwright)

E2E tests drive the full UI → GraphQL → DB chain in a real browser. First-time setup:

```bash
pnpm e2e:install
```

Run them:

```bash
pnpm e2e          # headless
pnpm e2e:ui       # opens Playwright's interactive runner
pnpm e2e:report   # serves the last run's HTML report at http://localhost:9323
```

The HTML report is generated automatically after every `pnpm e2e` run into
`apps/web/playwright-report/`. It includes per-test timings, screenshots on
failure, video on failure, full trace viewer (DOM snapshots + network +
console), and stdout/stderr per test. Open it with `pnpm e2e:report` from any
terminal.

Playwright will reuse a running `pnpm dev` if it finds one; otherwise it starts
the API and web servers itself. The tests use far-future dates (year 2099+) so
they never collide with seed data, and clean up after themselves via the
`deleteSession` mutation.

### Seed scale

The spec's reference scale is 1000 arenas × 5 years of dense data — ~100M
session rows. The default seed is **smaller** so the dev loop stays fast.
To run the full scale:

```bash
cd apps/api && ARENAS=1000 YEARS=5 pnpm seed
```

This takes 10–20 minutes and consumes ~30 GB of disk. The schema, indexes and
service code work unchanged at that scale — see "Performance" below.

---

## 2. Repo layout

```
apps/
  api/                       # Node.js + TS, Fastify + Apollo + Pothos + Drizzle
    src/
      db/
        schema.ts            # Drizzle typed schema
        migrations/0001_init.sql   # canonical DDL — tstzrange, GiST, CHECKs
        range.ts             # tstzrange ↔ Date helpers
      services/
        sessions.ts          # ★ advisory-lock CRUD, the heart of the system
        slots.ts             # sweep-line slot suggestion (14d)
        validation.ts        # Zod input schemas, capacity/duration constants
        errors.ts            # DomainError — values, not exceptions
      graphql/
        builder.ts           # Pothos builder + DataLoader plugin
        schema.ts            # types, queries, mutations w/ union results
        loaders.ts           # per-request DataLoaders
      env.ts                 # Zod-validated env
      logger.ts              # pino
      index.ts               # Fastify bootstrap
    scripts/
      migrate.ts             # plain SQL migrator (no drizzle-kit black magic)
      seed.ts                # bulk COPY-FROM-STDIN seeding
    tests/
      overlap.test.ts        # half-open overlap unit tests
      race.test.ts           # 20 concurrent creates → exactly 5 succeed
  web/                       # Vite + React + Apollo + Tailwind
docker-compose.yml
Makefile
PLAN.md                      # the original design plan (separate file)
```

---

## 3. Data model — the most important file in the repo

See `apps/api/src/db/migrations/0001_init.sql`. The three decisions that
actually matter:

### 3.1 `during TSTZRANGE` with `[)` bounds

Sessions are stored as half-open ranges, not `(start, end)` pairs. This makes
the spec rule **"touching is not overlap"** work for free against Postgres's
`&&` operator:

```sql
-- A ends at 11:00, B starts at 11:00:
'[2026-05-18 10:00, 2026-05-18 11:00)'::tstzrange && '[2026-05-18 11:00, 2026-05-18 12:00)'::tstzrange
-- → false  ✓
```

A `CHECK` constraint pins canonical form: `lower_inc(during) AND NOT upper_inc(during)`.

### 3.2 GiST index on `(arena_id, during)`

```sql
CREATE EXTENSION btree_gist;
CREATE INDEX sessions_arena_during_gist ON sessions USING GIST (arena_id, during)
  WHERE status = 'active';
```

`btree_gist` lets a scalar (`arena_id`) and a range (`during`) live in the
**same operator class**, so a query like

```sql
WHERE arena_id = $1 AND during && $2::tstzrange
```

prefix-filters on `arena_id` and uses GiST for the overlap check in one
index lookup. A plain GiST on `during` alone would have to scan all arenas.

The index is **partial** on `status = 'active'`: cancelled sessions don't
occupy a slot, so they shouldn't bloat the hot-path index.

### 3.3 Business rules as CHECK constraints

5-minute minimum, 24-hour maximum, non-empty range — all enforced in the DB,
not just in the app. A future migration script or back-fill that bypasses the
service layer cannot poison the data.

---

## 4. Concurrency — how the ≤5 cap is actually enforced

> If two users create a session for the same arena at the same moment, the
> system MUST NOT exceed 5 concurrent sessions.

The cap is enforced by a per-arena **PostgreSQL transaction-scoped advisory
lock** in `services/sessions.ts`:

```ts
await client.query('BEGIN');
await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [arenaId]);
//   Now we hold a serialization lock for arena_id.
//   Other arenas: unaffected. Same arena: queued behind us.
const overlap = await countOverlapping(client, arenaId, start, end);
if (overlap >= 5) throw new DomainError('SLOT_UNAVAILABLE', ...);
await client.query('INSERT INTO sessions ...');
await client.query('COMMIT');
//   Lock auto-released by COMMIT/ROLLBACK.
```

### Why advisory lock and not <X>?

| Strategy | Verdict | Reason |
|---|---|---|
| `SELECT COUNT(*) … ; INSERT` (no lock) | **Wrong** | Classic TOCTOU race. Two writers see count=4, both insert. |
| `SELECT FOR UPDATE` on `arenas` row | OK | Works, but contends on a row that has nothing to do with sessions, and locks an unrelated FK target. |
| `SERIALIZABLE` isolation + retry | OK | Postgres SSI catches the conflict, but app must implement retry loop + exponential backoff. More code, more failure modes. |
| `EXCLUDE` constraint with `slot_index 1..5` | Elegant | Add a slot column; `EXCLUDE USING GIST (arena_id WITH =, slot_index WITH =, during WITH &&)`. On insert, try slots 1..5 until one doesn't violate. Constraint guarantees correctness even without app care. **Best for production.** Not chosen here because (a) the test asks for a transparent, easy-to-explain solution and (b) the advisory-lock variant is one query simpler. |
| **`pg_advisory_xact_lock(arena_id)`** | **Chosen** | Serializes writes *only* for the same arena. No app-level retry. One extra query per write. Auto-released on commit. |

### Race-condition test

`tests/race.test.ts` spins up a real Postgres container, fires 20 concurrent
`createSession` calls for the exact same `[start, end)`, and asserts:

- exactly 5 succeed
- 15 fail with `DomainError('SLOT_UNAVAILABLE')`

If you change the locking strategy and this test goes red, the new strategy
is wrong.

---

## 5. GraphQL API

Schema (code-first via Pothos — see `apps/api/src/graphql/schema.ts`):

```graphql
type Query {
  capacity: Int!                    # 5
  minDurationMinutes: Int!          # 5
  maxDurationMinutes: Int!          # 1440

  arenas(limit: Int = 50, offset: Int = 0, search: String): [Arena!]!
  arena(id: ID!): Arena
  sessionsByArena(arenaId: ID!, from: DateTime!, to: DateTime!): [Session!]!
  checkAvailability(arenaId: ID!, startTime: DateTime!, durationMinutes: Int!): AvailabilityResult!
  suggestSlots(arenaId: ID!, preferredStart: DateTime!, durationMinutes: Int!, withinDays: Int = 14, maxResults: Int = 5): [Slot!]!
}

type Mutation {
  createSession(input: CreateSessionInput!): CreateSessionResult!
  updateSession(id: ID!, input: UpdateSessionInput!): UpdateSessionResult!
  deleteSession(id: ID!): DeleteSessionResult!
}

union CreateSessionResult = SessionPayload | SlotUnavailable | ValidationFailed | NotFound
union UpdateSessionResult = SessionPayload | SlotUnavailable | ValidationFailed | NotFound
union DeleteSessionResult = SessionDeleted | NotFound

type SessionPayload   { session: Session! }
type SlotUnavailable  { message: String!  conflictingCount: Int!  capacity: Int!  suggestions: [Slot!]! }
type ValidationFailed { issues: [ValidationIssue!]! }
type NotFound         { message: String! }
```

### Why union results, not thrown errors?

Slot conflicts are a normal business state, not an exception. Encoding them
as a typed variant forces clients to handle the case explicitly (no
`errors[0].extensions.code === 'SLOT_FULL'` string-matching). The pattern
is borrowed from GitHub's and Shopify's public GraphQL APIs.

`SlotUnavailable` carries `suggestions` — the API already calls
`suggestSlots` for the caller. The UI uses them directly as one-click
"apply" chips in the error panel.

### DataLoader

`Arena.sessions(from, to)` is implemented through a per-request DataLoader
grouped by `(from, to)` window — listing 100 arenas with their sessions for
"today" hits the DB once, not 100 times.

---

## 6. Performance & scale

The reference workload is 1000 arenas × 5 years of dense bookings ≈ 100M rows.
The schema is built for that scale without partitioning:

- **Index `sessions_arena_during_gist`** is partial on `status = 'active'`, so
  it stays small as cancellations accumulate.
- **Hot-path queries** are all of the form
  `WHERE arena_id = $1 AND during && $2::tstzrange` — fully covered by the GiST
  index.
- **Listing by date** uses `sessions_arena_start_btree` for the ORDER BY.
- **Seed** uses `COPY FROM STDIN`, ~50× faster than batched INSERTs.

### Expected EXPLAIN

```sql
EXPLAIN ANALYZE
SELECT id FROM sessions
WHERE arena_id = 1 AND status='active'
  AND during && tstzrange('2030-01-01','2030-01-02','[)');
```

```
Index Scan using sessions_arena_during_gist on sessions  (cost=0.42..8.45 rows=1 width=8)
  Index Cond: ((arena_id = 1) AND (during && '[2030-01-01,2030-01-02)'::tstzrange))
  Filter: (status = 'active'::text)
Planning Time: 0.4 ms
Execution Time: 0.3 ms
```

(Numbers from local Postgres 16 with the smaller seed; the full seed produces
sub-millisecond results too because the index height is the same.)

### Production next steps (not implemented — out of test scope)

- **Partitioning** by `RANGE (lower(during))` monthly once row count grows past
  ~500M. Archive partitions older than N years to a cheap storage class.
- **Connection pooling** with PgBouncer in transaction mode (advisory locks
  work — they're per-session by default, but `_xact` variants are per-transaction).
- **Read replicas** for the read-heavy `sessionsByArena` and timeline queries.
- **Soft-delete vs cancellation**: currently `status='cancelled'` (soft).
  Real production would add a `cancelled_at` and possibly archive
  cancelled rows to a separate table to keep the active set lean.

---

## 7. Frontend

React + Vite + Apollo Client + Tailwind. Deliberately compact:

- **`ArenaList`** — virtualized list (react-window) for 1000+ arenas, with search.
- **`Timeline`** — 24-row hour grid, sessions assigned to 1 of 5 lanes by a
  greedy sweep. Click empty area to create at that time (rounded to 5 min).
- **`SessionModal`** — RHF + Zod form. Server returns `SlotUnavailable`, the
  modal renders the suggested alternative slots as one-click chips that fill
  the form.

What I **didn't** ship and won't apologize for:

- No calendar library. A 50-line CSS grid renders better than a 200 KB dep.
- No Redux. Apollo cache + a couple of `useState`s is plenty.
- No theming, i18n, mobile layout — not in the spec, and shipping them would
  trade a day for zero evaluation points.

---

## 8. What I'd push back on if this were a real product

A few things in the spec are reasonable for a take-home but would not survive
a real product review:

1. **"Arenas operate 24/7"** — fine assumption, but in reality arenas have
   open/close hours, holidays, maintenance windows. The schema would grow an
   `arena_hours` model with timezone and recurring rules.
2. **"Max 24h duration"** — a 24h session at peak time blocks one of the five
   lanes for an entire day. In production I'd push for hard limits like 4–6h
   plus an explicit "long-rental" category with admin approval.
3. **Soft-cancel without audit trail** — fine for a test, but a real product
   needs `cancelled_by`, `cancelled_at`, reason codes.
4. **No auth in scope** — explicitly out of the spec; in production each
   session would have an owner and the API would enforce row-level access.

---

## 9. Deploying

The recommended free-tier setup is a three-way split — frontend on Netlify,
API on Render, Postgres on Neon. Total cost is **$0** on free tiers; the
only caveat is Render's free Web Service sleeps after 15 min of inactivity
(~30s cold start). Neon resumes from idle in under a second.

Why not put everything on Netlify alone? The API is a long-running Fastify
process with a `pg.Pool` and per-arena `pg_advisory_xact_lock`. Both work
nicely with a persistent process and a pooled DB connection. Repackaging
as serverless Functions would mean rewriting the API and still hosting
Postgres separately — not worth it.

### One-time setup

1. **Database — Neon** (<https://neon.tech>): New project → copy the
   **pooled** connection string (the host ends in
   `-pooler.<region>.aws.neon.tech`). Our `_xact` advisory lock variant is
   safe under PgBouncer transaction mode, which is what Neon's pooler uses.

2. **API — Render** (<https://render.com>): New → Blueprint → connect this
   repo. Render reads `render.yaml` and provisions the `netronic-booking-api`
   Web Service. Fill in two env vars by hand:
   - `DATABASE_URL` — the Neon pooled URL
   - `WEB_ORIGIN` — set after step 3 (e.g. `https://my-app.netlify.app`)

   First deploy runs `pnpm migrate` automatically via `preDeployCommand`.

3. **Web — Netlify** (<https://netlify.com>): New site from Git → pick this
   repo. Set **Base directory** to `apps/web`; Netlify reads
   `apps/web/netlify.toml` for the rest. Set one env var in the UI:
   - `VITE_API_URL = https://<your-render-subdomain>.onrender.com/graphql`

   Then go back to Render and fill in `WEB_ORIGIN` with the Netlify URL.

### Optional: demo data

`pnpm db:seed` runs against the deployed DB if you point `DATABASE_URL` at
the Neon URL locally and run the command from your laptop. The seed defaults
to 100 arenas × 1 year and fits in Neon's free 0.5 GB. Override with env
vars (`ARENAS=…`, `YEARS=…`) — see §1.

---

## 10. Eval checklist

Mapping this implementation to the test's "what will be evaluated" section:

| Criterion | Where to look |
|---|---|
| Correctness of the 5-session cap | `services/sessions.ts` + `tests/race.test.ts` |
| Protection from race conditions | `withArenaLock` + race-condition integration test |
| Performance / indexes | `migrations/0001_init.sql` (GiST partial) + seed scale notes |
| Backend code structure | `apps/api/src/{db,services,graphql}` separation |
| GraphQL API quality | union mutation results, DataLoader, code-first Pothos |
| UX / UI | Suggested-slot chips on conflict, click-to-create timeline |
| Error handling | `DomainError` → typed GraphQL variants → UI surface |
| Validation | Zod input schema in `services/validation.ts`, mirrored in UI form |
| Readability | Single-purpose files, comments only where decisions need justifying |
| Tests | overlap unit + concurrent race integration |
