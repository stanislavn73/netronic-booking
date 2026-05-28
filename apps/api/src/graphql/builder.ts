import SchemaBuilder from '@pothos/core';
import { DateTimeResolver } from 'graphql-scalars';

export interface GraphQLContext {
  loaders: import('./loaders.js').Loaders;
}

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date };
    ID: { Input: string; Output: string | number };
  };
}>({});

builder.addScalarType('DateTime', DateTimeResolver, {});
