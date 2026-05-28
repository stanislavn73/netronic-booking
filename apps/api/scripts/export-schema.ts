/**
 * Emit the runtime GraphQL schema as SDL to `apps/api/schema.graphql`.
 * Consumed by `apps/web` codegen — the on-disk SDL is the source of truth so
 * codegen doesn't need the API running.
 *
 * Run via `pnpm --filter @app/api schema:export`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printSchema, lexicographicSortSchema } from 'graphql';
import { schema } from '../src/graphql/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, '..', 'schema.graphql');

const sdl = printSchema(lexicographicSortSchema(schema));
writeFileSync(OUTPUT, sdl + '\n', 'utf8');
console.log(`wrote ${sdl.length} bytes → ${OUTPUT}`);
