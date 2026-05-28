/**
 * Query-root registration. Side-effect import: `builder.queryType(...)`
 * mutates the builder state. `schema.ts` imports this file so its effects
 * run before `builder.toSchema()`.
 */
import { builder } from './builder.js';
import {
  ARENA_CAPACITY,
  MAX_DURATION_MIN,
  MIN_DURATION_MIN,
} from '../services/validation.js';
import { getArena, listArenas } from '../services/arenas.js';
import { checkAvailability, sessionsByArena } from '../services/sessions.js';
import { suggestSlots } from '../services/slots.js';
import { ms, minutes } from '../time.js';
import {
  ArenaRef,
  AvailabilityResultRef,
  SessionRef,
  SlotRef,
} from './types.js';

builder.queryType({
  fields: (t) => ({
    capacity: t.int({ resolve: () => ARENA_CAPACITY }),
    minDurationMinutes: t.int({ resolve: () => MIN_DURATION_MIN }),
    maxDurationMinutes: t.int({ resolve: () => MAX_DURATION_MIN }),

    arenas: t.field({
      type: [ArenaRef],
      args: {
        limit: t.arg.int({ defaultValue: 50 }),
        offset: t.arg.int({ defaultValue: 0 }),
        search: t.arg.string({ required: false }),
      },
      resolve: (_p, args) =>
        listArenas({
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          search: args.search ?? undefined,
        }),
    }),

    arena: t.field({
      type: ArenaRef,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: (_p, { id }) => getArena(Number(id)),
    }),

    sessionsByArena: t.field({
      type: [SessionRef],
      args: {
        arenaId: t.arg.id({ required: true }),
        from: t.arg({ type: 'DateTime', required: true }),
        to: t.arg({ type: 'DateTime', required: true }),
      },
      resolve: (_p, { arenaId, from, to }) => sessionsByArena(Number(arenaId), from, to),
    }),

    checkAvailability: t.field({
      type: AvailabilityResultRef,
      args: {
        arenaId: t.arg.id({ required: true }),
        startTime: t.arg({ type: 'DateTime', required: true }),
        durationMinutes: t.arg.int({ required: true }),
      },
      resolve: (_p, { arenaId, startTime, durationMinutes }) => {
        const end = new Date(startTime.getTime() + minutes(durationMinutes));
        return checkAvailability(Number(arenaId), startTime, end);
      },
    }),

    suggestSlots: t.field({
      type: [SlotRef],
      args: {
        arenaId: t.arg.id({ required: true }),
        preferredStart: t.arg({ type: 'DateTime', required: true }),
        durationMinutes: t.arg.int({ required: true }),
        withinDays: t.arg.int({ defaultValue: 14 }),
        maxResults: t.arg.int({ defaultValue: 5 }),
      },
      resolve: (_p, { arenaId, preferredStart, durationMinutes, withinDays, maxResults }) =>
        suggestSlots({
          arenaId: Number(arenaId),
          preferredStart,
          durationMs: minutes(durationMinutes),
          horizonMs: (withinDays ?? 14) * ms.day,
          maxResults: maxResults ?? 5,
        }),
    }),
  }),
});
