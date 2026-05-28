/**
 * Domain errors. These are values, not exceptions — they bubble up as
 * union-typed GraphQL results so clients have to handle each case explicitly.
 */

export type DomainErrorCode =
  | 'ARENA_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SLOT_UNAVAILABLE'
  | 'INVALID_DURATION'
  | 'INVALID_TIME'
  | 'VALIDATION_FAILED';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
