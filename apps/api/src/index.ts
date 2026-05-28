/**
 * Server bootstrap — Fastify 5 + Apollo Server 5 GraphQL endpoint.
 */
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { ApolloServer } from '@apollo/server';
import {
  fastifyApolloDrainPlugin,
  fastifyApolloHandler,
} from '@as-integrations/fastify';
import { env } from './env.js';
import { logger } from './logger.js';
import { schema } from './graphql/schema.js';
import { createLoaders } from './graphql/loaders.js';
import { pool } from './db/index.js';
import type { GraphQLContext } from './graphql/builder.js';

async function main() {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024, // 1 MB — GraphQL queries are never bigger
  });

  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  const apollo = new ApolloServer<GraphQLContext>({
    schema,
    plugins: [fastifyApolloDrainPlugin(app)],
    introspection: env.NODE_ENV !== 'production',
  });
  await apollo.start();

  // Mount GraphQL at /graphql with a per-request context that holds loaders.
  app.route({
    url: '/graphql',
    method: ['GET', 'POST', 'OPTIONS'],
    handler: fastifyApolloHandler(apollo, {
      context: async () => ({ loaders: createLoaders() }),
    }),
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await apollo.stop();
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`GraphQL ready at http://localhost:${env.PORT}/graphql`);
}

main().catch((err) => {
  logger.fatal({ err }, 'server bootstrap failed');
  process.exit(1);
});
