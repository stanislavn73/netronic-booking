/**
 * Domain errors — values, not exceptions in the traditional sense. They
 * bubble up as discriminated-union GraphQL results so clients must handle
 * each case explicitly.
 *
 * `meta` is typed per code via {@link DomainErrorMetaByCode} so resolvers
 * read fields without casts. Fields that may not always be populated
 * (e.g. `SLOT_UNAVAILABLE.fillsUpAt` when the cap isn't hit) are optional.
 */

export interface DomainErrorMetaByCode {
  ARENA_NOT_FOUND: { arenaId?: number };
  SESSION_NOT_FOUND: { sessionId?: number };
  SLOT_UNAVAILABLE: {
    arenaId: number;
    start: Date;
    end: Date;
    conflictingCount: number;
    fillsUpAt?: Date | null;
    maxAvailableDurationMinutes?: number;
  };
  INVALID_DURATION: { durationMinutes?: number };
  INVALID_TIME: { reason?: string };
  VALIDATION_FAILED: { issues?: ReadonlyArray<{ field: string; message: string }> };
}

export type DomainErrorCode = keyof DomainErrorMetaByCode;

export class DomainError<C extends DomainErrorCode = DomainErrorCode> extends Error {
  constructor(
    public readonly code: C,
    message: string,
    public readonly meta: DomainErrorMetaByCode[C] = {} as DomainErrorMetaByCode[C],
  ) {
    super(message);
    this.name = 'DomainError';
  }

  /** Type-narrowing predicate: `if (err.is('SLOT_UNAVAILABLE')) err.meta.start`. */
  is<K extends DomainErrorCode>(code: K): this is DomainError<K> {
    return (this.code as DomainErrorCode) === code;
  }
}
