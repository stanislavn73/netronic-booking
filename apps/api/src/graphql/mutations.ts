/**
 * Mutation-root registration. Side-effect import: `builder.mutationType(...)`
 * mutates the builder state.
 *
 * Resolvers stay thin — parse input → call a service → translate any throw
 * via `mapMutationError` into the right union variant. Domain logic does
 * NOT live here.
 */
import { builder } from './builder.js';
import { createSession, deleteSession, updateSession } from '../services/sessions.js';
import { mapMutationError } from './error-mapping.js';
import { CreateSessionInput, UpdateSessionInput } from './inputs.js';
import {
  CreateSessionResult,
  DeleteSessionResult,
  UpdateSessionResult,
} from './types.js';

builder.mutationType({
  fields: (t) => ({
    createSession: t.field({
      type: CreateSessionResult,
      args: { input: t.arg({ type: CreateSessionInput, required: true }) },
      resolve: async (_p, { input }) => {
        try {
          const session = await createSession({
            arenaId: Number(input.arenaId),
            startTime: input.startTime,
            endTime: input.endTime ?? undefined,
            durationMinutes: input.durationMinutes ?? undefined,
            playerName: input.playerName ?? undefined,
          });
          return { session };
        } catch (err) {
          return mapMutationError(err);
        }
      },
    }),

    updateSession: t.field({
      type: UpdateSessionResult,
      args: {
        id: t.arg.id({ required: true }),
        input: t.arg({ type: UpdateSessionInput, required: true }),
      },
      resolve: async (_p, { id, input }) => {
        try {
          const session = await updateSession(Number(id), {
            startTime: input.startTime ?? undefined,
            endTime: input.endTime ?? undefined,
            durationMinutes: input.durationMinutes ?? undefined,
            playerName: input.playerName,
          });
          return { session };
        } catch (err) {
          return mapMutationError(err);
        }
      },
    }),

    deleteSession: t.field({
      type: DeleteSessionResult,
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_p, { id }) => {
        try {
          return await deleteSession(Number(id));
        } catch (err) {
          const variant = await mapMutationError(err);
          if ('message' in variant) return variant;
          throw err;
        }
      },
    }),
  }),
});
