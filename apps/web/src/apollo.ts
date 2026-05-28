import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';

/**
 * GraphQL endpoint URL.
 *
 *   - Dev:  the Vite proxy in vite.config.ts forwards `/graphql` → :4000,
 *           so the default relative path Just Works without an env var.
 *   - Prod: build with `VITE_API_URL=https://api.example.com/graphql`.
 *           Netlify reads this from the site's Environment Variables and
 *           Vite inlines it at build time — there is no runtime config.
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
});
