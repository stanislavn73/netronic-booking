import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';

/**
 * GraphQL endpoint URL.
 *
 *   - Dev:  the Vite proxy in vite.config.ts forwards `/graphql` → :4000,
 *           so the default relative path works without an env var.
 *   - Prod: build with `VITE_API_URL=https://api.example.com/graphql`. Vite
 *           inlines the value at build time — there is no runtime config.
 */
const GRAPHQL_URI = import.meta.env.VITE_API_URL ?? '/graphql';

export const apollo = new ApolloClient({
  link: new HttpLink({ uri: GRAPHQL_URI }),
  cache: new InMemoryCache({
    typePolicies: {
      Arena: { keyFields: ['id'] },
      Session: { keyFields: ['id'] },
    },
  }),
  defaultOptions: {
    // `cache-and-network` keeps the UI responsive (shows cache instantly) while
    // still reconciling with fresh data — appropriate for everything in this
    // app, which is small and read-heavy. Override per-call if you need stricter.
    watchQuery: { fetchPolicy: 'cache-and-network', nextFetchPolicy: 'cache-first' },
    query: { fetchPolicy: 'network-only' },
  },
});
