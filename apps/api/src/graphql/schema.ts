/**
 * GraphQL schema (Pothos, code-first). Mutation results are discriminated
 * unions — slot conflicts are normal business state, not exceptions. Error
 * translation lives in `./error-mapping.ts`.
 */
import { builder } from './builder.js';
import {
  ARENA_CAPACITY,
  MAX_DURATION_MIN,
  MIN_DURATION_MIN,
} from '../services/validation.js';
import {
  checkAvailability,
  createSession,
  deleteSession,
  getArena,
  listArenas,
  sessionsByArena,
  updateSession,
  type SessionRecord,
} from '../services/sessions.js';
import { suggestSlots } from '../services/slots.js';
import { mapMutationError } from './error-mapping.js';
import { mutationResultTypeName } from './resolve-type.js';
import { ms, minutes } from '../time.js';

// =============================================================================
// Object types
// =============================================================================

interface ArenaT {
  id: number;
  name: string;
  createdAt: Date;
}

const ArenaRef = builder.objectRef<ArenaT>('Arena');
ArenaRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    sessions: t.field({
      type: [SessionRef],
      args: {
        from: t.arg({ type: 'DateTime', required: true }),
        to: t.arg({ type: 'DateTime', required: true }),
      },
      resolve: (arena, { from, to }, ctx) =>
        ctx.loaders.sessionsByArena(from, to).load(arena.id),
    }),
  }),
});

const SessionStatusEnum = builder.enumType('SessionStatus', {
  values: ['active', 'cancelled'] as const,
});

const SessionRef = builder.objectRef<SessionRecord>('Session');
SessionRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    arenaId: t.exposeID('arenaId'),
    startTime: t.expose('startTime', { type: 'DateTime' }),
    endTime: t.expose('endTime', { type: 'DateTime' }),
    durationMinutes: t.int({
      resolve: (s) => Math.round((s.endTime.getTime() - s.startTime.getTime()) / ms.minute),
    }),
    playerName: t.exposeString('playerName', { nullable: true }),
    status: t.field({ type: SessionStatusEnum, resolve: (s) => s.status }),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    updatedAt: t.expose('updatedAt', { type: 'DateTime' }),
  }),
});

const SlotRef = builder.objectRef<{ start: Date; end: Date }>('Slot');
SlotRef.implement({
  fields: (t) => ({
    start: t.expose('start', { type: 'DateTime' }),
    end: t.expose('end', { type: 'DateTime' }),
  }),
});

const ValidationIssueRef = builder.objectRef<{ field: string; message: string }>(
  'ValidationIssue',
);
ValidationIssueRef.implement({
  fields: (t) => ({
    field: t.exposeString('field'),
    message: t.exposeString('message'),
  }),
});

// =============================================================================
// Result variants
// =============================================================================

const SessionPayloadRef = builder.objectRef<{ session: SessionRecord }>('SessionPayload');
SessionPayloadRef.implement({
  fields: (t) => ({
    session: t.field({ type: SessionRef, resolve: (p) => p.session }),
  }),
});

interface SlotUnavailableT {
  message: string;
  conflictingCount: number;
  capacity: number;
  suggestions: Array<{ start: Date; end: Date }>;
  fillsUpAt: Date | null;
  maxAvailableDurationMinutes: number;
}
const SlotUnavailableRef = builder.objectRef<SlotUnavailableT>('SlotUnavailable');
SlotUnavailableRef.implement({
  fields: (t) => ({
    message: t.exposeString('message'),
    conflictingCount: t.exposeInt('conflictingCount'),
    capacity: t.exposeInt('capacity'),
    suggestions: t.field({ type: [SlotRef], resolve: (p) => p.suggestions }),
    fillsUpAt: t.field({
      type: 'DateTime',
      nullable: true,
      resolve: (p) => p.fillsUpAt,
    }),
    maxAvailableDurationMinutes: t.exposeInt('maxAvailableDurationMinutes'),
  }),
});

const ValidationFailedRef = builder.objectRef<{ issues: { field: string; message: string }[] }>(
  'ValidationFailed',
);
ValidationFailedRef.implement({
  fields: (t) => ({
    issues: t.field({ type: [ValidationIssueRef], resolve: (p) => p.issues }),
  }),
});

const NotFoundRef = builder.objectRef<{ message: string }>('NotFound');
NotFoundRef.implement({
  fields: (t) => ({ message: t.exposeString('message') }),
});

const SessionDeletedRef = builder.objectRef<{ id: number }>('SessionDeleted');
SessionDeletedRef.implement({
  fields: (t) => ({ id: t.exposeID('id') }),
});

const CreateSessionResult = builder.unionType('CreateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: mutationResultTypeName,
});

const UpdateSessionResult = builder.unionType('UpdateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: mutationResultTypeName,
});

const DeleteSessionResult = builder.unionType('DeleteSessionResult', {
  types: [SessionDeletedRef, NotFoundRef],
  resolveType: (v) => ('id' in v ? 'SessionDeleted' : 'NotFound'),
});

const AvailabilityResultRef = builder.objectRef<{
  available: boolean;
  conflictingCount: number;
  capacity: number;
  maxAvailableDurationMinutes: number;
  fillsUpAt: Date | null;
}>('AvailabilityResult');
AvailabilityResultRef.implement({
  fields: (t) => ({
    available: t.exposeBoolean('available'),
    conflictingCount: t.exposeInt('conflictingCount'),
    capacity: t.exposeInt('capacity'),
    maxAvailableDurationMinutes: t.exposeInt('maxAvailableDurationMinutes'),
    fillsUpAt: t.field({
      type: 'DateTime',
      nullable: true,
      resolve: (p) => p.fillsUpAt,
    }),
  }),
});

// =============================================================================
// Inputs
// =============================================================================

const CreateSessionInput = builder.inputType('CreateSessionInput', {
  fields: (t) => ({
    arenaId: t.id({ required: true }),
    startTime: t.field({ type: 'DateTime', required: true }),
    endTime: t.field({ type: 'DateTime', required: false }),
    durationMinutes: t.int({ required: false }),
    playerName: t.string({ required: false }),
  }),
});

const UpdateSessionInput = builder.inputType('UpdateSessionInput', {
  fields: (t) => ({
    startTime: t.field({ type: 'DateTime', required: false }),
    endTime: t.field({ type: 'DateTime', required: false }),
    durationMinutes: t.int({ required: false }),
    playerName: t.string({ required: false }),
  }),
});

// =============================================================================
// Queries
// =============================================================================

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

// =============================================================================
// Mutations
// =============================================================================

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

export const schema = builder.toSchema();
