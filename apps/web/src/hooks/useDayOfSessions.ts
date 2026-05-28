import { useMemo } from 'react';
import { useQuery } from '@apollo/client';
import { SESSIONS_BY_ARENA } from '@/gql/queries';
import { dayWindow } from '@/lib/date';
import type { Session } from '@/lib/types';

/**
 * Sessions overlapping a single LOCAL day for the given arena. Shared by
 * the Timeline view and by the SessionModal's refetch wiring, which need
 * to agree on the day-window cache key.
 */
export function useDayOfSessions(arenaId: string, date: Date) {
  const { from, to } = useMemo(() => dayWindow(date), [date]);
  const queryVars = useMemo(
    () => ({ arenaId, from: from.toISOString(), to: to.toISOString() }),
    [arenaId, from, to],
  );
  const query = useQuery<{ sessionsByArena: Session[] }>(SESSIONS_BY_ARENA, {
    variables: queryVars,
    fetchPolicy: 'cache-and-network',
  });
  return { ...query, from, to, queryVars };
}
