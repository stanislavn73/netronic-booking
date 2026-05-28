/**
 * Arenas service — thin orchestration over the arena repo functions.
 *
 * Read-only at the moment; arenas are seeded, not created via the API.
 * Lives in its own file so `services/sessions.ts` doesn't carry passthrough
 * re-exports for a different entity.
 */
import {
  getArenaById,
  listArenas as listArenasRepo,
  type ArenaRow,
  type ListArenasArgs,
} from '../db/sessions.repo.js';

export type Arena = ArenaRow;
export type { ListArenasArgs };

/** List arenas with optional ILIKE search and bounded pagination. */
export const listArenas = (args: ListArenasArgs = {}): Promise<Arena[]> => listArenasRepo(args);

/** Fetch an arena by id, or null if it doesn't exist. */
export const getArena = (id: number): Promise<Arena | null> => getArenaById(id);
