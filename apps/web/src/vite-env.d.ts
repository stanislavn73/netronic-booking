/// <reference types="vite/client" />

/**
 * Custom Vite env vars. Anything prefixed with `VITE_` is exposed to the
 * client bundle via `import.meta.env`. Declare each one here so TypeScript
 * knows about it and `apollo.ts` doesn't need a cast.
 */
interface ImportMetaEnv {
  /** GraphQL endpoint URL. Falls back to `/graphql` via the dev proxy. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
