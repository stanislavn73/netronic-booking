import { LANES, OVERFLOW_LANE } from '@/components/Timeline/constants';
import type { Session } from '@/lib/types';

export type PlacedSession = Session & { lane: number };

/**
 * Greedy lane assignment over the {@link LANES} capacity lanes.
 *
 * If a session does not fit into any lane (impossible for data the API has
 * accepted — the cap is enforced server-side), the session is tagged with
 * {@link OVERFLOW_LANE} and `console.error`-logged. The render layer paints
 * overflow blocks red so an invariant breach is visible, not silently
 * stacked on lane 0.
 */
export function assignLanes(sessions: readonly Session[]): PlacedSession[] {
  const laneEnds: number[] = Array.from({ length: LANES }, () => 0);
  const out: PlacedSession[] = [];
  for (const s of [...sessions].sort(
    (a, b) => +new Date(a.startTime) - +new Date(b.startTime),
  )) {
    const start = +new Date(s.startTime);
    const end = +new Date(s.endTime);
    let assigned = OVERFLOW_LANE;
    for (let i = 0; i < LANES; i++) {
      if ((laneEnds[i] ?? 0) <= start) {
        assigned = i;
        laneEnds[i] = end;
        break;
      }
    }
    if (assigned === OVERFLOW_LANE) {
      // eslint-disable-next-line no-console
      console.error(
        '[Timeline] capacity invariant violated — more than',
        LANES,
        'overlapping sessions for arena',
        s.arenaId,
        'at',
        new Date(start).toISOString(),
        '— DB cap may have been bypassed',
        s,
      );
    }
    out.push({ ...s, lane: assigned });
  }
  return out;
}
