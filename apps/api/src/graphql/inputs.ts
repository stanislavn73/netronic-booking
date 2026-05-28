/**
 * GraphQL input types. Field-level validation lives in the Zod schemas
 * in `services/validation.ts`; this file is just the wire shape.
 */
import { builder } from './builder.js';

export const CreateSessionInput = builder.inputType('CreateSessionInput', {
  fields: (t) => ({
    arenaId: t.id({ required: true }),
    startTime: t.field({ type: 'DateTime', required: true }),
    endTime: t.field({ type: 'DateTime', required: false }),
    durationMinutes: t.int({ required: false }),
    playerName: t.string({ required: false }),
  }),
});

export const UpdateSessionInput = builder.inputType('UpdateSessionInput', {
  fields: (t) => ({
    startTime: t.field({ type: 'DateTime', required: false }),
    endTime: t.field({ type: 'DateTime', required: false }),
    durationMinutes: t.int({ required: false }),
    playerName: t.string({ required: false }),
  }),
});
