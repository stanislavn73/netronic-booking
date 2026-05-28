/**
 * Type re-exports from the generated GraphQL operations file.
 * Source of truth: `operations.graphql` + `apps/api/schema.graphql`,
 * compiled by `pnpm codegen` into `src/gql/__generated__/operations.ts`.
 * Do NOT add hand-rolled types here.
 *
 * Each alias is derived from the smallest shape the UI actually queries —
 * no over-broad "full schema" types. Names preserve historical aliases so
 * call sites don't have to change.
 */
import type {
  ArenasQuery,
  CheckAvailabilityQuery,
  CreateSessionMutation,
  SessionFieldsFragment,
  SlotUnavailableFieldsFragment,
} from '@/gql/__generated__/operations';

/** Listed arena (id + name only — what `ArenasQuery` fetches). */
export type Arena = ArenasQuery['arenas'][number];

/** Full Session shape the UI uses, matching the `SessionFields` fragment. */
export type Session = SessionFieldsFragment;

/** Availability probe result. */
export type AvailabilityResult = CheckAvailabilityQuery['checkAvailability'];

/** Suggestion slot — `{ start, end }` ISO instants. */
export type SlotSuggestion = SlotUnavailableFieldsFragment['suggestions'][number];

/** Shape of `ValidationFailed.issues[i]` returned by any session mutation. */
export type ValidationIssue = Extract<
  CreateSessionMutation['createSession'],
  { __typename: 'ValidationFailed' }
>['issues'][number];

/**
 * SlotUnavailable payload as returned by createSession / updateSession.
 * Mirrors the `SlotUnavailableFields` fragment.
 */
export type SlotUnavailablePayload = SlotUnavailableFieldsFragment;
