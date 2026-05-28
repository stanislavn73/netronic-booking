import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';

export const apollo = new ApolloClient({
  link: new HttpLink({ uri: '/graphql' }),
  cache: new InMemoryCache({
    typePolicies: {
      Arena: { keyFields: ['id'] },
      Session: { keyFields: ['id'] },
    },
  }),
});
