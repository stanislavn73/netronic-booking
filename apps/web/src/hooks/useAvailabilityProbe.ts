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
 * @param arenaId    Arena to probe.
 * @param startIso   ISO-8601 UTC instant, or `null` to skip the query.
 * @param excludeId  Session id to exclude from the count — pass the edited
 *                   session's id so the hint doesn't count it against itself
 *                   (matches the server's write-time probe). Omit on create.
 */
export function useAvailabilityProbe(
  arenaId: string,
  startIso: string | null,
  excludeId?: string,
) {
  const { data, loading } = useQuery<{ checkAvailability: AvailabilityResult }>(
    CHECK_AVAILABILITY,
    {
      skip: !startIso,
      variables: startIso
        ? {
            arenaId,
            startTime: startIso,
            durationMinutes: 5,
            excludeSessionId: excludeId ?? null,
          }
        : undefined,
      fetchPolicy: 'cache-and-network',
    },
  );
  return { data: data?.checkAvailability, loading };
}
