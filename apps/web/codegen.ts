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
      // `typescript-operations` already emits every input/enum its
      // operations reference. We deliberately do NOT add the `typescript`
      // plugin — that duo emits each input twice and tsc rejects it.
      plugins: ['typescript-operations', 'typed-document-node'],
      config: {
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
