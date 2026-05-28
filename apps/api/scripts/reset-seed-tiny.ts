/**
 * Reset the database to a tiny dataset that fits comfortably in Neon's
 * free-tier storage (≤ a few MB end-to-end).
 *
 * Sets sensible env-var defaults, then hands off to `scripts/seed.ts` —
 * which TRUNCATEs `sessions`/`arenas` first, re-seeds via COPY, and ends
 * the pool. Override any env to customize:
 *
 *     ARENAS=20 YEARS=0.25 pnpm --filter @app/api reset:seed:tiny
 *
 * After this finishes, production storage drops dramatically and the
 * lane backfill + 0003 EXCLUDE migration become safe to run.
 */

// Defaults — applied only when not already set, so explicit overrides win.
process.env.ARENAS ??= '10';
process.env.YEARS ??= '0.1'; // ≈ 36 days centred on today
process.env.LANES ??= '5';
process.env.AVG_MIN ??= '60';

// seed.ts has its own top-level `main()` and ends the pool when it finishes.
await import('./seed.js');

export {};
