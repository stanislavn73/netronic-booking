/**
 * Pothos schema entry point.
 *
 * The actual schema is assembled by side-effect imports:
 *
 *   - `./types.js`     registers object refs, enums, and union types
 *   - `./inputs.js`    registers `*Input` types
 *   - `./queries.js`   registers the query root
 *   - `./mutations.js` registers the mutation root
 *
 * After those run, `builder.toSchema()` materializes the final
 * `GraphQLSchema` for Apollo Server.
 */
import { builder } from './builder.js';
import './types.js';
import './inputs.js';
import './queries.js';
import './mutations.js';

export const schema = builder.toSchema();
