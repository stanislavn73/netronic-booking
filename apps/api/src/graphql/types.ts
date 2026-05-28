/**
 * Object refs, enums, and union types for the GraphQL schema.
 *
 * Side effects: every `builder.objectRef(...).implement(...)`,
 * `builder.enumType(...)`, and `builder.unionType(...)` here registers a
 * type on the Pothos builder. Anyone importing the named refs gets the
 * registration for free.
 *
 * Forward references between refs work because Pothos's `fields` callback
 * is evaluated lazily during `builder.toSchema()`, not when this file
 * loads — order within the file is purely stylistic.
 */
import { builder } from './builder.js';
import type { SessionRecord } from '../services/sessions.js';
import { ms } from '../time.js';
import { mutationResultTypeName } from './resolve-type.js';

// =============================================================================
// Domain object refs
// =============================================================================

export interface ArenaT {
  id: number;
  name: string;
  createdAt: Date;
}

export const ArenaRef = builder.objectRef<ArenaT>('Arena');
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

export const SessionStatusEnum = builder.enumType('SessionStatus', {
  values: ['active', 'cancelled'] as const,
});

export const SessionRef = builder.objectRef<SessionRecord>('Session');
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

export const SlotRef = builder.objectRef<{ start: Date; end: Date }>('Slot');
SlotRef.implement({
  fields: (t) => ({
    start: t.expose('start', { type: 'DateTime' }),
    end: t.expose('end', { type: 'DateTime' }),
  }),
});

export const ValidationIssueRef = builder.objectRef<{ field: string; message: string }>(
  'ValidationIssue',
);
ValidationIssueRef.implement({
  fields: (t) => ({
    field: t.exposeString('field'),
    message: t.exposeString('message'),
  }),
});

// =============================================================================
// Mutation result variants (and the unions that wrap them)
// =============================================================================

export const SessionPayloadRef = builder.objectRef<{ session: SessionRecord }>('SessionPayload');
SessionPayloadRef.implement({
  fields: (t) => ({
    session: t.field({ type: SessionRef, resolve: (p) => p.session }),
  }),
});

export interface SlotUnavailableT {
  message: string;
  conflictingCount: number;
  capacity: number;
  suggestions: Array<{ start: Date; end: Date }>;
  fillsUpAt: Date | null;
  maxAvailableDurationMinutes: number;
}

export const SlotUnavailableRef = builder.objectRef<SlotUnavailableT>('SlotUnavailable');
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

export const ValidationFailedRef = builder.objectRef<{
  issues: { field: string; message: string }[];
}>('ValidationFailed');
ValidationFailedRef.implement({
  fields: (t) => ({
    issues: t.field({ type: [ValidationIssueRef], resolve: (p) => p.issues }),
  }),
});

export const NotFoundRef = builder.objectRef<{ message: string }>('NotFound');
NotFoundRef.implement({
  fields: (t) => ({ message: t.exposeString('message') }),
});

export const SessionDeletedRef = builder.objectRef<{ id: number }>('SessionDeleted');
SessionDeletedRef.implement({
  fields: (t) => ({ id: t.exposeID('id') }),
});

export const CreateSessionResult = builder.unionType('CreateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: mutationResultTypeName,
});

export const UpdateSessionResult = builder.unionType('UpdateSessionResult', {
  types: [SessionPayloadRef, SlotUnavailableRef, ValidationFailedRef, NotFoundRef],
  resolveType: mutationResultTypeName,
});

export const DeleteSessionResult = builder.unionType('DeleteSessionResult', {
  types: [SessionDeletedRef, NotFoundRef],
  resolveType: (v) => ('id' in v ? 'SessionDeleted' : 'NotFound'),
});

// =============================================================================
// Read-only availability shape
// =============================================================================

export const AvailabilityResultRef = builder.objectRef<{
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
