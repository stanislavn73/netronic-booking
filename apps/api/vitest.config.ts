import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Force a single `graphql` instance. Under pnpm the package is reachable via
  // more than one path, so the Pothos-built schema and a test's own
  // `import { graphql }` can load different module realms; graphql's instanceof
  // guard then throws "Cannot use GraphQLSchema from another module or realm"
  // (suggestion-duration.test.ts). Only one version is installed — it's a
  // realm-identity issue, not a version conflict. `dedupe` collapses vite's
  // resolution; inlining graphql pulls it into vite's module graph (instead of
  // being externalized and loaded by Node) so every importer shares the one
  // transformed instance.
  resolve: {
    dedupe: ['graphql'],
  },
  test: {
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    server: {
      deps: {
        // Inline the whole schema-building chain (graphql + graphql-scalars +
        // Pothos) so it shares vite's single deduped `graphql` instance with a
        // test's own `import { graphql }`. Inlining graphql alone is not enough:
        // Pothos (which calls `builder.toSchema()` and thus constructs the
        // GraphQLSchema) stays externalized and would build the schema from a
        // different graphql realm, re-tripping the instanceof guard.
        inline: [/graphql/, /@pothos/],
      },
    },
  },
});
