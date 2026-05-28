import { useState } from 'react';
import { addDays, format, parse } from 'date-fns';
import { ArenaList } from './components/ArenaList';
import { Timeline } from './components/Timeline';
import { SessionModal } from './components/SessionModal';
import type { Session } from './lib/types';

type ModalMode =
  | { kind: 'create'; arenaId: string; initialStart: Date }
  | { kind: 'edit'; session: Session };

export function App() {
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [date, setDate] = useState<Date>(() => new Date());
  const [modal, setModal] = useState<ModalMode | null>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-zinc-200">Netronic Booking</h1>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            ≤ 5 concurrent sessions per arena
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate(addDays(date, -1))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
          >
            ←
          </button>
          <input
            type="date"
            value={format(date, 'yyyy-MM-dd')}
            onChange={(e) => {
              // `new Date("2026-05-27")` parses as UTC midnight — on a
              // non-UTC machine that's a different local day than the user
              // picked. date-fns `parse` interprets the string as LOCAL,
              // which is what every other piece of date handling in the app
              // assumes.
              if (!e.target.value) return;
              setDate(parse(e.target.value, 'yyyy-MM-dd', new Date()));
            }}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
          />
          <button
            onClick={() => setDate(addDays(date, 1))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
          >
            →
          </button>
          <button
            onClick={() => setDate(new Date())}
            className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
          >
            Today
          </button>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <ArenaList selectedId={arenaId} onSelect={setArenaId} />
        {arenaId ? (
          <Timeline
            arenaId={arenaId}
            date={date}
            onEditSession={(s) => setModal({ kind: 'edit', session: s })}
            onClickEmpty={(initialStart) =>
              setModal({ kind: 'create', arenaId, initialStart })
            }
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-500">
            Pick an arena to view its sessions.
          </div>
        )}
      </div>
      {modal && arenaId && (
        <SessionModal
          mode={modal}
          arenaId={arenaId}
          date={date}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
