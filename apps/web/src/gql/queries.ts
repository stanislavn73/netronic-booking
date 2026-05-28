/**
 * Typed re-exports of generated GraphQL operations.
 *
 * Operation source lives in `operations.graphql`. Codegen produces
 * `__generated__/operations.ts` with `TypedDocumentNode`s — Apollo's
 * `useQuery` / `useMutation` auto-infer Data and Variables from them, so
 * call sites don't need `<TData, TVars>` generics.
 *
 * Names below preserve the SCREAMING_SNAKE_CASE that existing imports use.
 * Regenerate with `pnpm codegen` after editing `operations.graphql` or the
 * server schema.
 */
export {
  ArenasDocument as ARENAS_QUERY,
  CheckAvailabilityDocument as CHECK_AVAILABILITY,
  SessionsByArenaDocument as SESSIONS_BY_ARENA,
  CreateSessionDocument as CREATE_SESSION,
  UpdateSessionDocument as UPDATE_SESSION,
  DeleteSessionDocument as DELETE_SESSION,
  SessionFieldsFragmentDoc as SESSION_FIELDS,
  SlotUnavailableFieldsFragmentDoc as SLOT_UNAVAILABLE_FIELDS,
} from './__generated__/operations';
