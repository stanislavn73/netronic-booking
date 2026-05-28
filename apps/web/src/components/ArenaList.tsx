import { useMemo, useState } from 'react';
import { useQuery } from '@apollo/client';
import { FixedSizeList as VList } from 'react-window';
import { ARENAS_QUERY } from '../gql/queries';
import type { Arena } from '../lib/types';
import clsx from 'clsx';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ArenaList({ selectedId, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const { data, loading, error } = useQuery<{ arenas: Arena[] }>(ARENAS_QUERY, {
    variables: { search: search || null },
  });

  const arenas = useMemo(() => data?.arenas ?? [], [data]);

  return (
    <aside className="flex w-72 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="border-b border-zinc-800 p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search arenas…"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="p-4 text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">{error.message}</div>
        ) : arenas.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">No arenas match.</div>
        ) : (
          <VList
            height={window.innerHeight - 80}
            width="100%"
            itemCount={arenas.length}
            itemSize={48}
          >
            {({ index, style }) => {
              const arena = arenas[index]!;
              const active = selectedId === arena.id;
              return (
                <button
                  type="button"
                  style={style}
                  onClick={() => onSelect(arena.id)}
                  className={clsx(
                    'flex w-full items-center px-4 text-left text-sm transition',
                    active
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'text-zinc-300 hover:bg-zinc-800/60',
                  )}
                >
                  <span className="mr-3 inline-block h-2 w-2 rounded-full bg-zinc-600" />
                  {arena.name}
                </button>
              );
            }}
          </VList>
        )}
      </div>
    </aside>
  );
}
