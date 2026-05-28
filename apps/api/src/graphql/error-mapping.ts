/**
 * Resolver-layer error mapping. Translates thrown errors from the service
 * into the discriminated-union variants the GraphQL schema returns.
 *
 * Unknown errors are re-thrown so Apollo can surface them as proper
 * `errors[]` entries instead of silently masking bugs.
 */
import { ZodError } from 'zod';
import { DomainError } from '../services/errors.js';
import { buildSlotUnavailable, type SlotUnavailablePayload } from '../services/availability.js';
import type { SessionRecord } from '../services/sessions.js';
import { ROOT_FIELD } from './resolve-type.js';

export type ValidationVariant = { issues: Array<{ field: string; message: string }> };
export type NotFoundVariant = { message: string };
export type SessionVariant = { session: SessionRecord };

export type MutationVariant =
  | SessionVariant
  | ValidationVariant
  | NotFoundVariant
  | SlotUnavailablePayload;

/** Map a thrown error to a union variant; re-throws anything unrecognized. */
export async function mapMutationError(err: unknown): Promise<MutationVariant> {
  if (err instanceof ZodError) {
    return {
      issues: err.issues.map((i) => ({
        field: i.path.join('.') || ROOT_FIELD,
        message: i.message,
      })),
    };
  }
  if (err instanceof DomainError) {
    if (err.is('SLOT_UNAVAILABLE')) {
      const { arenaId, start, end, conflictingCount, fillsUpAt, maxAvailableDurationMinutes } =
        err.meta;
      return buildSlotUnavailable({
        arenaId,
        start,
        end,
        conflictingCount,
        fillsUpAt: fillsUpAt ?? null,
        maxAvailableDurationMinutes: maxAvailableDurationMinutes ?? 0,
      });
    }
    if (err.is('ARENA_NOT_FOUND') || err.is('SESSION_NOT_FOUND')) {
      return { message: err.message };
    }
    if (err.is('INVALID_DURATION') || err.is('INVALID_TIME')) {
      return { issues: [{ field: ROOT_FIELD, message: err.message }] };
    }
    if (err.is('VALIDATION_FAILED')) {
      const issues = err.meta.issues ?? [{ field: ROOT_FIELD, message: err.message }];
      return { issues: issues.map((i) => ({ field: i.field, message: i.message })) };
    }
  }
  throw err;
}
