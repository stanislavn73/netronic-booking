/**
 * GraphQL codegen config. Source of truth: `../api/schema.graphql` (regen
 * via `pnpm --filter @app/api schema:export`).
 *
 * Output: `src/gql/__generated__/operations.ts` — schema types +
 * per-operation `Query`/`QueryVariables` types + `TypedDocumentNode`s.
 *
 * Run: `pnpm codegen` (one-shot) or `pnpm codegen:watch` (incremental).
 */
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: '../api/schema.graphql',
  documents: ['src/gql/operations.graphql'],
  ignoreNoDocuments: false,
  generates: {
    'src/gql/__generated__/operations.ts': {
      // The `typescript` base plugin emits the shared helpers (`Scalars`,
      // `Maybe`, `InputMaybe`, `Exact`) plus the input objects and enums the
      // operations reference; `typescript-operations` emits the per-operation
      // Variables/Result types that USE them; `typed-document-node` emits the
      // TypedDocumentNodes. Current plugin versions make `typescript-operations`
      // reference those base/input types rather than self-emit them, so the
      // base plugin is required for the output to typecheck. `onlyOperationTypes`
      // limits the base plugin to just the inputs/enums actually used, so
      // nothing is emitted twice.
      plugins: ['typescript', 'typescript-operations', 'typed-document-node'],
      config: {
        onlyOperationTypes: true,
        scalars: { DateTime: 'string', ID: 'string' },
        avoidOptionals: { field: true, inputValue: false, object: true },
        enumsAsTypes: true,
        useTypeImports: true,
        dedupeFragments: true,
        skipTypename: false,
        documentMode: 'documentNode',
        // Import TypedDocumentNode from Apollo (already a dep) instead of
        // adding a separate `@graphql-typed-document-node/core` peer.
        documentNodeImport: '@apollo/client/core#TypedDocumentNode',
        namingConvention: { enumValues: 'keep' },
      },
    },
  },
};

export default config;
