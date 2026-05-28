import { z } from 'zod';

export const ARENA_CAPACITY = 5;
export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 24 * 60;

/**
 * Input schema for create/update. We accept either explicit endTime or
 * durationMinutes — the spec calls this out. Service layer normalizes
 * to a [start, end) range.
 */
export const SessionInputSchema = z
  .object({
    arenaId: z.coerce.number().int().positive(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(MIN_DURATION_MIN).max(MAX_DURATION_MIN).optional(),
    playerName: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.endTime || v.durationMinutes, {
    message: 'Either endTime or durationMinutes is required',
    path: ['endTime'],
  });

export type SessionInput = z.infer<typeof SessionInputSchema>;

export interface NormalizedSession {
  arenaId: number;
  start: Date;
  end: Date;
  playerName?: string;
}

export function normalizeInput(input: SessionInput): NormalizedSession {
  const start = input.startTime;
  const end = input.endTime ?? new Date(start.getTime() + (input.durationMinutes ?? 0) * 60_000);
  const durMs = end.getTime() - start.getTime();
  if (durMs < MIN_DURATION_MIN * 60_000) {
    throw new Error(`Duration must be ≥ ${MIN_DURATION_MIN} minutes`);
  }
  if (durMs > MAX_DURATION_MIN * 60_000) {
    throw new Error(`Duration must be ≤ ${MAX_DURATION_MIN / 60} hours`);
  }
  return { arenaId: input.arenaId, start, end, playerName: input.playerName };
}
