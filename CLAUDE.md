# CLAUDE.md — agent quick start

You're working on **Netronic Booking** — a GraphQL API + React UI for
scheduling arena game sessions with a hard cap of 5 concurrent per arena.

**Read this file first.** It points you at the right detailed docs so you
don't have to scan the whole tree on every task. Detailed conventions live
under `.claude/`.

---

## 1. Where things live

```
apps/
  api/                 # Fastify + Apollo + Pothos + Drizzle + Postgres
    src/
      db/              # Drizzle schema, raw SQL migrations, range helpers
      services/        # Domain logic — cap-check + slot suggestion
      graphql/         # Pothos schema, loaders, builder
      env.ts logger.ts index.ts
    scripts/           # migrate, seed (COPY FROM STDIN)
    tests/             # vitest: overlap unit, race integration, etc.
  web/
    src/
      ui/              # Button, Input, Field, Modal, Badge (no domain logic)
      components/      # Domain components (ArenaList, Timeline/, SessionModal/)
      hooks/           # useEscapeKey, useAvailabilityProbe, useSessionMutations,
                       # useDayOfSessions
      lib/             # date.ts, concurrency.ts, types.ts (no React, no GQL)
      gql/             # queries.ts + fragments.ts
      apollo.ts main.tsx App.tsx
CLAUDE.md              # ← you are here
.claude/
  ARCHITECTURE.md      # Folder rules, file size budgets, JSDoc convention
  AGENTS.md            # Token-efficiency rules for future agents
README.md              # Human-facing setup + deploy guide
PLAN.md                # Historical design notes (don't update)
```

---

## 2. The most important invariant

**The 5-cap check uses MAX-CONCURRENT, not COUNT(*).** See
`apps/api/src/services/sessions.ts → maxConcurrentDuring`. If you "fix"
this by replacing it with `COUNT(*)` you will reintroduce the prod "8 of 5"
bug. The spec says "at any moment in time" — implement that literally
via sweep-line over events clipped to the proposed window.

---

## 3. Common commands

```bash
make up                     # docker postgres on :5433
make migrate                # apply SQL migrations
make seed                   # generate 100 arenas × 1y of dense data
pnpm dev                    # API :4000 + web :5173 in parallel
pnpm test                   # api vitest (needs make up first)
pnpm e2e                    # playwright (boots its own dev servers)
```

Typecheck only (fastest sanity check before committing):

```bash
cd apps/api && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd apps/web && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

---

## 4. Code conventions in one paragraph

Components ≤ 150 LOC. Files do one job. Domain logic lives in hooks/services,
not in JSX. Tailwind classes only via `ui/` primitives — never repeat a long
class string across files. Hand-rolled types in `lib/types.ts` mirror the
GraphQL schema (codegen pending — task P1-6). JSDoc on every export; inline
`//` comments only where the WHY isn't obvious from the code. Path alias
`@/` → `apps/web/src/`. Full detail: **`.claude/ARCHITECTURE.md`**.

---

## 5. Working efficiently

Before doing anything substantial, follow **`.claude/AGENTS.md`** — it lists
the token-efficient patterns we want from any agent on this repo (Glob
before Read, batch typechecks, never read whole files when grep will do).

---

## 6. Deploy

Production: Web on Netlify (`apps/web/netlify.toml`), API on Render
(`render.yaml`), Postgres on Neon. Full walkthrough in `README.md §9`.
