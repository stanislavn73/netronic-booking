/**
 * Narrow type guards for Postgres driver errors we care about. Catching
 * "any error with code 23P03" is too broad — that could trip on a future
 * unrelated EXCLUDE on the same table. We always match on the specific
 * constraint name.
 */

/** SQLSTATE 23P03 — exclusion_violation. */
export const EXCLUSION_VIOLATION = '23P03';

interface PgError {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgError | null {
  return err !== null && typeof err === 'object' ? (err as PgError) : null;
}

/**
 * True iff `err` is a Postgres exclusion violation against the named
 * constraint. Used by the lane-allocation retry loop to differentiate
 * "lost the lane race, try again" from any other failure.
 */
export function isExclusionViolation(err: unknown, constraintName: string): boolean {
  const e = asPgError(err);
  return e !== null && e.code === EXCLUSION_VIOLATION && e.constraint === constraintName;
}
