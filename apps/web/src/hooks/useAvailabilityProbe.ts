import { useQuery } from '@apollo/client';
import { CHECK_AVAILABILITY } from '@/gql/queries';
import type { AvailabilityResult } from '@/lib/types';

/**
 * Probe the server for occupancy at a given start. Re-fetches when `startIso`
 * changes; Apollo caches by variables so static inputs are free.
 *
 * Passes a 5-minute placeholder duration — the only field this hook returns
 * (`maxAvailableDurationMinutes`) depends solely on the start, not duration.
 *
 * @param arenaId   Arena to probe.
 * @param startIso  ISO-8601 UTC instant, or `null` to skip the query.
 */
export function useAvailabilityProbe(arenaId: string, startIso: string | null) {
  const { data, loading } = useQuery<{ checkAvailability: AvailabilityResult }>(
    CHECK_AVAILABILITY,
    {
      skip: !startIso,
      variables: startIso
        ? { arenaId, startTime: startIso, durationMinutes: 5 }
        : undefined,
      fetchPolicy: 'cache-and-network',
    },
  );
  return { data: data?.checkAvailability, loading };
}
