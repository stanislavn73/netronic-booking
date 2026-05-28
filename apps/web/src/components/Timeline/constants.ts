/** Capacity (number of concurrent lanes per arena). Mirrors server-side. */
export const LANES = 5;
/** Pixels per hour row in the Timeline grid. */
export const HOUR_PX = 60;
/** Milliseconds in 24 hours. */
export const DAY_MS = 24 * 3_600_000;
/** Sentinel lane index used when no lane is free — surfaces invariant breaks. */
export const OVERFLOW_LANE = -1;
