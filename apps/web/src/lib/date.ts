/**
 * Date helpers shared across the web app.
 *
 * The most important one: `dayWindow(date)` produces the [from, to) half-open
 * pair the API expects. Using a single source means the Timeline query and
 * the SessionModal's refetchQueries variables produce IDENTICAL cache keys,
 * so Apollo updates the same cache entry instead of holding two.
 */
import { addDays, startOfDay } from 'date-fns';

/**
 * Return the half-open `[from, to)` window covering a single LOCAL day.
 *
 * Why half-open: matches the API's tstzrange semantics and avoids the
 * 1-millisecond hole at `23:59:59.999` that `endOfDay()` leaves.
 *
 * Why local time: the user's date picker is local; rendering the timeline
 * relative to local midnight is what makes the hour grid line up visually.
 */
export function dayWindow(date: Date): { from: Date; to: Date } {
  const from = startOfDay(date);
  const to = startOfDay(addDays(date, 1));
  return { from, to };
}
