import { z } from 'zod';

/**
 * Form fields for creating or editing a session. Matches the UI input shape:
 * `startTime` is a `<input type="datetime-local">` value (LOCAL time string),
 * not an ISO instant.
 */
export const SessionFormSchema = z.object({
  startTime: z.string().min(1),
  durationMinutes: z.coerce.number().int().min(5).max(24 * 60),
  playerName: z.string().max(120).optional(),
});

export type SessionFormData = z.infer<typeof SessionFormSchema>;
