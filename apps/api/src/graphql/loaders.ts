import DataLoader from 'dataloader';
import { sessionsByArenaBatch, type SessionRecord } from '../services/sessions.js';

/**
 * Per-request loaders. We batch by (from, to) windows — most lists in a single
 * request share the same date range, so grouping by window keeps the DB
 * payload to one query per window.
 */
export function createLoaders() {
  const cache = new Map<string, DataLoader<number, SessionRecord[]>>();

  return {
    sessionsByArena(from: Date, to: Date) {
      const key = `${from.toISOString()}|${to.toISOString()}`;
      let loader = cache.get(key);
      if (!loader) {
        loader = new DataLoader<number, SessionRecord[]>(async (arenaIds) => {
          const grouped = await sessionsByArenaBatch(arenaIds as number[], from, to);
          return arenaIds.map((id) => grouped.get(id) ?? []);
        });
        cache.set(key, loader);
      }
      return loader;
    },
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
