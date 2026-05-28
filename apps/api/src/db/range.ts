/**
 * tstzrange (de)serialization helpers.
 *
 * We always emit half-open [start, end) ranges. This is the whole reason the
 * "touching is not overlap" rule works for free against Postgres's && operator.
 */

/** Build a half-open `[start, end)` literal accepted by tstzrange. */
export function rangeLiteral(start: Date, end: Date): string {
  // Postgres tolerates ISO-8601 with timezone inside the range literal.
  return `[${start.toISOString()},${end.toISOString()})`;
}

/** Parse Postgres tstzrange textual output, e.g. `["2026-01-01 09:00:00+00","2026-01-01 10:00:00+00")` */
export function parseRange(literal: string): { start: Date; end: Date } {
  const match = literal.match(/^([\[(])"?([^",)]+)"?,"?([^",)]+)"?([\])])$/);
  if (!match) throw new Error(`Invalid tstzrange literal: ${literal}`);
  const [, , startStr, endStr] = match;
  if (!startStr || !endStr) throw new Error(`Invalid tstzrange literal: ${literal}`);
  return { start: new Date(startStr), end: new Date(endStr) };
}
