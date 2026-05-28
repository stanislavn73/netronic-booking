export interface Arena {
  id: string;
  name: string;
}

export interface Session {
  id: string;
  arenaId: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  playerName: string | null;
  status: 'active' | 'cancelled';
}

export interface SlotSuggestion {
  start: string;
  end: string;
}

export interface AvailabilityResult {
  available: boolean;
  /** Peak concurrent active sessions during the proposed window. */
  conflictingCount: number;
  capacity: number;
  /** Largest duration (minutes) that would fit at the proposed start. */
  maxAvailableDurationMinutes: number;
  /** ISO-8601 instant where the cap is first reached, or null. */
  fillsUpAt: string | null;
}
