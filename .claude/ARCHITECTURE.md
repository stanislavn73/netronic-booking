# Architecture & Conventions

This is the detailed reference. The root `CLAUDE.md` is the index.

---

## 1. Folder rules

### `apps/web/src/ui/`
Generic, app-agnostic visual primitives. Encapsulate the Tailwind class
strings so the same input/button look isn't redefined in every component.

- One component per file.
- **NO domain types, NO GraphQL, NO date-fns business logic.**
- Each component exports its prop type as `XxxProps`.
- Variants → string-record + `clsx`. No `cva` dependency unless we add it
  intentionally.

If you find yourself reaching for `text-zinc-700 border …` in a component,
the answer is "add it as a variant on a `ui/` primitive", not "copy-paste".

### `apps/web/src/components/`
Domain components. Each one has access to GraphQL, hooks, and the domain
types. Compose `ui/` primitives, never re-style them inline.

- Bigger components are folders (`Timeline/`, `SessionModal/`) with an
  `index.ts` barrel.
- Each subfile has one concern: e.g., `SessionBlock.tsx` renders one block,
  `lanes.ts` computes assignment, `constants.ts` holds the magic numbers.

### `apps/web/src/hooks/`
Custom hooks. The rule of thumb: if a `useEffect` is more than 8 lines, or
if a `useQuery` is wired more than once, extract a hook.

- Name `useXxx`.
- Returns plain values / functions (not JSX).
- Encapsulates Apollo-shaped state (`data`, `loading`, `error`) when it
  wraps a query.

### `apps/web/src/lib/`
Pure helpers. No React, no Apollo, no DOM.

- `date.ts` — every date conversion. If a component is doing `new Date(...)`
  twice, the third call goes in `date.ts`.
- `concurrency.ts` — the sweep-line for hourly density. Pure, testable.
- `types.ts` — hand-rolled GraphQL shapes (replace with codegen later).

### `apps/web/src/gql/`
- `fragments.ts` — shared fragments. If a field set appears in two
  queries/mutations, extract a fragment.
- `queries.ts` — every query/mutation document. Single file is OK at
  current size; split into per-domain files if it grows past 300 LOC.

### `apps/api/src/services/`
Domain logic, framework-free. Functions take a `PoolClient`, return data
or throw `DomainError`. Resolvers translate `DomainError` to GraphQL
union variants — they never invent business rules.

### `apps/api/src/graphql/`
Pothos schema (code-first). Resolvers are thin: parse input → call a
service → map errors to result variants.

---

## 2. File size budgets

| Kind | Soft cap | Reasoning |
|---|---|---|
| `ui/` primitive | 60 LOC | If bigger, it's doing too much. |
| Hook | 60 LOC | Same. |
| Domain component | 150 LOC | Split into a folder past this. |
| Service file | 300 LOC | Split by domain entity past this. |
| GraphQL doc file | 300 LOC | Split by entity. |

These aren't hard limits — the goal is forcing the right question ("can
this be smaller?") before adding more.

---

## 3. The JSDoc convention

**On every export**: a JSDoc summary line (one sentence). Add a multi-line
block when the function has non-obvious behaviour, edge cases, or trade-offs
the next reader needs.

```ts
/**
 * Probes occupancy at a given start. Re-fetches when `startIso` moves;
 * Apollo caches by variables so static inputs are free.
 *
 * @param arenaId   Arena to probe.
 * @param startIso  ISO-8601 UTC instant, or `null` to skip the query.
 */
export function useAvailabilityProbe(...)
```

Inline `//` comments are for **non-obvious local reasoning**. Examples of
what to KEEP:

```ts
// Order: -1 (ends) before +1 (starts) at the same instant so two sessions
// where one ends exactly when the next begins don't count as concurrent.
events.sort((a, b) => a.t - b.t || a.order - b.order);
```

Examples of what to **delete** (the code already says this):

```ts
// Build event list
const events = [];
```

```ts
// Set the state
setError(null);
```

Big top-of-file headers explaining architectural decisions
(e.g. the original `Timeline.tsx` comment about lane assignment) are fine
and useful — those are docs, not narration.

---

## 4. GraphQL — fragments are mandatory

Any field set that appears in two operations must be a fragment in
`gql/fragments.ts`. Reason: drift. Adding a server-side field then
forgetting one of two inline duplicates is how UI bugs ship.

Current fragments:
- `SessionFields` — every Session field the UI uses.
- `SlotUnavailableFields` — every SlotUnavailable field the UI uses
  (`fillsUpAt`, `maxAvailableDurationMinutes`, etc.).

---

## 5. Reusability rules

- **Tailwind class strings are not reusable** — extract a `ui/` component.
- **Date conversions are not reusable** — extract a `lib/date.ts` helper.
- **`useEffect` is not reusable** — extract a hook.
- **Pieces of JSX are not reusable** — extract a component (with JSDoc).

If you find yourself copy-pasting more than ~3 lines, the third call site
is doing the extraction work, not adding a feature.

---

## 6. State / data ownership

- **Apollo cache** is the source of truth for server data. Don't mirror it
  in `useState`.
- **Form state** is owned by `react-hook-form`. Don't shadow it in
  `useState` either.
- `useState` is reserved for genuinely-local UI state: modal open/closed,
  search input, "auto-fit already applied" flags.
- Mutations refetch via `refetchQueries`, never via manual `cache.modify`,
  unless we have a reason `refetchQueries` can't handle.

---

## 7. Cap-check semantics (the rule that bit us in prod)

The spec rule "at any moment in time the count of active sessions shall
not exceed N" requires **max-concurrent**, not total-overlapping.

- **Server**: `apps/api/src/services/sessions.ts → maxConcurrentDuring`.
  Returns `{ max, firstFillAt }`. The cap check is `probe.max >= ARENA_CAPACITY`.
- **Client (display only)**: `apps/web/src/lib/concurrency.ts →
  hourlyPeakConcurrent`. Same algorithm, mirrored for visual density chips.

If you ever see `SELECT COUNT(*)` being compared against capacity, that's
a bug. The proof is in `apps/api/tests/race.test.ts` — the
"cap check uses MAX-CONCURRENT, not total touched" test.

---

## 8. Timezone handling

The Timeline UI works in **local time** end-to-end. The API speaks **UTC**.
The translation rules:

- `<input type="date">` value → use `parseDateInputValue(string)` from
  `lib/date.ts`. Never `new Date(string)` (which parses as UTC midnight,
  silently shifting the day for non-UTC users).
- `<input type="datetime-local">` value → use `datetimeLocalToIso(string)`
  on the way out (UTC ISO), `toDatetimeLocalValue(Date)` on the way in.
- The day window the Timeline queries comes from `dayWindow(date)`
  (LOCAL midnight, half-open). The same helper must be used by both the
  Timeline query and any mutation's `refetchQueries`, or the cache key
  won't match and the UI won't update.

---

## 9. Build / install gotchas (Render specifically)

These bit us during deploy. If you change `render.yaml` or the API
deploy config, keep them in mind:

1. **Render's free tier forbids `preDeployCommand`.** Run migrations as
   part of `startCommand` (`pnpm migrate && pnpm exec tsx src/index.ts`).
2. **Render sets `NODE_ENV=production` globally.** pnpm then skips
   devDependencies. Build needs `tsc` + `@types/node`; runtime needs
   `tsx`. Use `pnpm install --frozen-lockfile --prod=false` in
   `buildCommand`.
3. **Render strips `.gitignore`d files from the free-tier deploy upload.**
   `dist/` is ignored, so `node dist/index.js` won't find anything. We
   run via `tsx src/index.ts` at runtime.
4. **Fastify 5 needs `loggerInstance`, not `logger`,** when you pass a
   pre-built pino instance.
5. **Neon's pooled URL ends in `?sslmode=require`.** The node-pg driver
   doesn't pick that up — set `ssl: { rejectUnauthorized: false }` in
   `apps/api/src/db/index.ts` when `NODE_ENV=production`.

If any of these break again, the error will be subtle (build green but
runtime crash, or port-scan-timeout). Don't guess — read `render.yaml`
and `apps/api/src/{db,index,env}.ts` first.

---

## 10. Tests — what to add and where

- **Pure algorithm** (e.g., sweep-line, overlap math) → unit test in
  `apps/api/tests/` or a new `apps/web/src/lib/*.test.ts`. No DB.
- **Service behaviour** (cap check, race, suggestion) → integration test
  in `apps/api/tests/race.test.ts` (existing harness creates an isolated
  DB per run).
- **End-to-end flow** (UI → API → DB) → Playwright in
  `apps/web/tests-e2e/`. Slow, use sparingly.

When fixing a prod bug, write the regression test in the smallest layer
that proves the fix — usually a unit or service test, not e2e.
