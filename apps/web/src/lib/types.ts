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
