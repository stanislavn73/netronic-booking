/**
 * GraphQL schema (Pothos, code-first).
 *
 * Mutation results are discriminated unions, not `throw`. The client must
 * inline-fragment each variant — slot conflicts are a normal business state,
 * not an exception.
 */
import { ZodError } from 'zod';
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
import { DomainError } from '../services/errors.js';

// =============================================================================
// Types
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
      resolve: (s) => Math.round((s.endTime.getTime() - s.startTime.getTime()) / 60_000),
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
// Result union types — discriminated, exhaustive client handling.
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
  /** The first instant inside the proposal where the cap is reached. */
  fillsUpAt: Date | null;
  /** Max duration (minutes) that would fit at the proposed start. */
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
  fields: (t) => ({
    message: t.exposeString('message'),
  }),
});

const SessionDeletedRef = builder.objectRef<{ id: number }>('SessionDeleted');
SessionDeletedRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
  }),
});

const CreateSessionResult = builder.unionType('CreateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: (v) =>
    'session' in v
      ? 'SessionPayload'
      : 'issues' in v
        ? 'ValidationFailed'
        : 'suggestions' in v
          ? 'SlotUnavailable'
          : 'NotFound',
});

const UpdateSessionResult = builder.unionType('UpdateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: (v) =>
    'session' in v
      ? 'SessionPayload'
      : 'issues' in v
        ? 'ValidationFailed'
        : 'suggestions' in v
          ? 'SlotUnavailable'
          : 'NotFound',
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
    /** How long a proposal at this start can run without exceeding the cap. */
    maxAvailableDurationMinutes: t.exposeInt('maxAvailableDurationMinutes'),
    /** When the cap is first reached inside the proposed window, if at all. */
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
// Helpers — convert domain errors / Zod errors into union variants.
// =============================================================================

function zodIssues(err: ZodError) {
  return {
    issues: err.issues.map((i) => ({ field: i.path.join('.') || '_root', message: i.message })),
  };
}

/**
 * Build a SlotUnavailable variant with nearest-available suggestions sized to
 * the SAME duration the caller asked for.
 *
 * Previously this hard-coded a 1-hour fallback regardless of the requested
 * duration. A user trying to book a 3-hour session would see suggestion chips
 * for 1-hour gaps and still hit SLOT_UNAVAILABLE after clicking one — the
 * "nearest available slots" promise was a lie. The duration MUST be the
 * caller's requested window length.
 */
async function unavailableWithSuggestions(args: {
  arenaId: number;
  start: Date;
  end: Date;
  conflictingCount: number;
  fillsUpAt: Date | null;
  maxAvailableDurationMinutes: number;
}): Promise<SlotUnavailableT> {
  const durationMs = args.end.getTime() - args.start.getTime();
  const suggestions = await suggestSlots({
    arenaId: args.arenaId,
    preferredStart: args.start,
    durationMs,
  });
  // Human-friendly message — service already produced a more precise one,
  // but we cap it in case the client only looks at `message`.
  const message = args.fillsUpAt
    ? `Slot fills up at ${args.fillsUpAt.toISOString()} — your proposal would exceed ${ARENA_CAPACITY} concurrent`
    : `Slot unavailable — ${args.conflictingCount} of ${ARENA_CAPACITY} concurrent sessions already booked`;
  return {
    message,
    conflictingCount: args.conflictingCount,
    capacity: ARENA_CAPACITY,
    suggestions,
    fillsUpAt: args.fillsUpAt,
    maxAvailableDurationMinutes: args.maxAvailableDurationMinutes,
  };
}

/**
 * Derive [start, end) from a CreateSessionInput before the service runs.
 *
 * The service does the same derivation under Zod, but throws on conflict
 * before returning the parsed end. We replay it here purely so the
 * SlotUnavailable variant can size its suggestions correctly. Returns null
 * for invalid inputs — the service's ValidationFailed will fire first.
 */
function deriveCreateEnd(input: {
  startTime: Date;
  endTime?: Date | null;
  durationMinutes?: number | null;
}): Date | null {
  if (input.endTime) return input.endTime;
  if (input.durationMinutes != null) {
    return new Date(input.startTime.getTime() + input.durationMinutes * 60_000);
  }
  return null;
}

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
      resolve: async (_p, { arenaId, startTime, durationMinutes }) => {
        const end = new Date(startTime.getTime() + durationMinutes * 60_000);
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
          durationMs: durationMinutes * 60_000,
          horizonMs: (withinDays ?? 14) * 24 * 3600 * 1000,
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
          if (err instanceof ZodError) return zodIssues(err);
          if (err instanceof DomainError) {
            if (err.code === 'ARENA_NOT_FOUND' || err.code === 'SESSION_NOT_FOUND') {
              return { message: err.message };
            }
            if (err.code === 'SLOT_UNAVAILABLE') {
              // Prefer the actual normalized window from the service (always
              // populated on SLOT_UNAVAILABLE); fall back to deriving from the
              // raw input for forward-compatibility if a future code path
              // forgets to include them.
              const meta = err.meta as {
                start?: Date;
                end?: Date;
                conflictingCount?: number;
                fillsUpAt?: Date | null;
                maxAvailableDurationMinutes?: number;
              };
              const start = meta.start ?? input.startTime;
              const end =
                meta.end ??
                deriveCreateEnd({
                  startTime: input.startTime,
                  endTime: input.endTime,
                  durationMinutes: input.durationMinutes,
                }) ??
                // Last-resort 1h window — only reached if neither service nor
                // input gave us a duration. Logged so it's visible.
                new Date(start.getTime() + 60 * 60_000);
              return unavailableWithSuggestions({
                arenaId: Number(input.arenaId),
                start,
                end,
                conflictingCount: Number(meta.conflictingCount ?? 0),
                fillsUpAt: meta.fillsUpAt ?? null,
                maxAvailableDurationMinutes: Number(meta.maxAvailableDurationMinutes ?? 0),
              });
            }
            return { issues: [{ field: '_root', message: err.message }] };
          }
          throw err;
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
            // Null/string here means "explicitly set". Undefined means "untouched".
            // Pothos passes `null` for absent optional fields, so callers must send
            // playerName explicitly if they want to change it (matches UI behavior).
            playerName: input.playerName,
          });
          return { session };
        } catch (err) {
          if (err instanceof ZodError) return zodIssues(err);
          if (err instanceof DomainError) {
            if (err.code === 'SESSION_NOT_FOUND' || err.code === 'ARENA_NOT_FOUND') {
              return { message: err.message };
            }
            if (err.code === 'SLOT_UNAVAILABLE') {
              const meta = err.meta as {
                arenaId: number;
                start: Date;
                end: Date;
                conflictingCount: number;
                fillsUpAt?: Date | null;
                maxAvailableDurationMinutes?: number;
              };
              return unavailableWithSuggestions({
                arenaId: meta.arenaId,
                start: meta.start,
                end: meta.end,
                conflictingCount: meta.conflictingCount,
                fillsUpAt: meta.fillsUpAt ?? null,
                maxAvailableDurationMinutes: Number(meta.maxAvailableDurationMinutes ?? 0),
              });
            }
            return { issues: [{ field: '_root', message: err.message }] };
          }
          throw err;
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
          if (err instanceof DomainError && err.code === 'SESSION_NOT_FOUND') {
            return { message: err.message };
          }
          throw err;
        }
      },
    }),
  }),
});

export const schema = builder.toSchema();
