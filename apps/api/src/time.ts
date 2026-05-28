/** Millisecond constants and minute helpers — kills inline `60_000` magic. */

export const ms = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

/** Convert minutes to milliseconds. */
export const minutes = (n: number): number => n * ms.minute;

/** Convert milliseconds to whole minutes (floor). */
export const toMinutes = (n: number): number => Math.floor(n / ms.minute);
