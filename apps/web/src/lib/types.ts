/**
 * Hand-rolled types that mirror the GraphQL schema.
 *
 * TODO: replace with `@graphql-codegen` output (pending task P1-6). Until then,
 * keep this file in lockstep with `apps/api/src/graphql/schema.ts` — every
 * server-side field addition needs a matching edit here.
 */

export interface Arena {
  id: string;
  name: string;
}

export interface Session {
  id: string;
  arenaId: string;
  /** ISO-8601 UTC instant. */
  startTime: string;
  /** ISO-8601 UTC instant. */
  endTime: string;
  durationMinutes: number;
  playerName: string | null;
  status: 'active' | 'cancelled';
}

export interface SlotSuggestion {
  /** ISO-8601 UTC instant. */
  start: string;
  /** ISO-8601 UTC instant. */
  end: string;
}

export interface AvailabilityResult {
  available: boolean;
  /** Peak concurrent active sessions during the proposed window. */
  conflictingCount: number;
  capacity: number;
  /** Largest duration (minutes) that would fit at the proposed start. */
  maxAvailableDurationMinutes: number;
  /** ISO-8601 instant where the cap is first reached, or null. */
  fillsUpAt: string | null;
}

/** Shape of `ValidationFailed.issues[i]` from any session mutation. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * SlotUnavailable payload as returned by createSession / updateSession.
 * Mirrors the `SlotUnavailable` GraphQL type.
 */
export interface SlotUnavailablePayload {
  message: string;
  conflictingCount: number;
  capacity: number;
  suggestions: SlotSuggestion[];
  fillsUpAt: string | null;
  maxAvailableDurationMinutes: number;
}
