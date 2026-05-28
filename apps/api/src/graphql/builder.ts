import SchemaBuilder from '@pothos/core';
import { DateTimeResolver } from 'graphql-scalars';

export interface GraphQLContext {
  loaders: import('./loaders.js').Loaders;
}

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  DefaultFieldNullability: false;
  Scalars: {
    DateTime: { Input: Date; Output: Date };
    ID: { Input: string; Output: string | number };
  };
}>({
  // Pothos v4 default is nullable; we want the SDL to reflect what the
  // resolvers actually return — `id`, `name`, `arenaId`, etc. are non-null.
  defaultFieldNullability: false,
});

builder.addScalarType('DateTime', DateTimeResolver, {});
