/**
 * Shared discriminant for mutation result unions. Both `CreateSessionResult`
 * and `UpdateSessionResult` use this — keep all four variant shapes in sync.
 */

export const mutationResultTypeName = (v: object): string =>
  'session' in v
    ? 'SessionPayload'
    : 'issues' in v
      ? 'ValidationFailed'
      : 'suggestions' in v
        ? 'SlotUnavailable'
        : 'NotFound';

/** Field name used for `_root` when a domain error has no structural field. */
export const ROOT_FIELD = '_root';
