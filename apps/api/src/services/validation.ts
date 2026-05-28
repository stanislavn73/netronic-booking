import { z } from 'zod';
import { ms, minutes } from '../time.js';
import { DomainError } from './errors.js';

export const ARENA_CAPACITY = 5;
export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 24 * 60;

/**
 * Input schema for create. Accepts either `endTime` or `durationMinutes`;
 * the service-layer normalizer turns either into a `[start, end)` window.
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

/**
 * Assert that `[start, end)` lies within the spec's duration bounds.
 * @throws DomainError<'INVALID_DURATION'> if too short or too long.
 */
export function assertValidDuration(start: Date, end: Date): void {
  const durMs = end.getTime() - start.getTime();
  if (durMs < minutes(MIN_DURATION_MIN)) {
    throw new DomainError(
      'INVALID_DURATION',
      `Duration must be ≥ ${MIN_DURATION_MIN} minutes`,
      { durationMinutes: durMs / ms.minute },
    );
  }
  if (durMs > minutes(MAX_DURATION_MIN)) {
    throw new DomainError(
      'INVALID_DURATION',
      `Duration must be ≤ ${MAX_DURATION_MIN / 60} hours`,
      { durationMinutes: durMs / ms.minute },
    );
  }
}

/**
 * Normalize a {@link SessionInput} to `[start, end)`, deriving `end` from
 * `durationMinutes` when `endTime` is absent.
 */
export function normalizeInput(input: SessionInput): NormalizedSession {
  const start = input.startTime;
  const end = input.endTime ?? new Date(start.getTime() + minutes(input.durationMinutes ?? 0));
  assertValidDuration(start, end);
  return { arenaId: input.arenaId, start, end, playerName: input.playerName };
}
