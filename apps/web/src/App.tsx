import { useState } from 'react';
import { ArenaList } from '@/components/ArenaList';
import { DayNavigator } from '@/components/DayNavigator';
import { SessionModal, type SessionModalMode } from '@/components/SessionModal';
import { Timeline } from '@/components/Timeline';
import type { Session } from '@/lib/types';

/**
 * Root composition: header (title + day navigator), sidebar (arena list),
 * main pane (timeline or empty state), modal layer (create/edit).
 *
 * Holds only top-level state: selected arena id, current date, modal mode.
 */
export function App() {
  const [arenaId, setArenaId] = useState<string | null>(null);
  const [date, setDate] = useState<Date>(() => new Date());
  const [modal, setModal] = useState<SessionModalMode | null>(null);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-zinc-200">Netronic Booking</h1>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            ≤ 5 concurrent sessions per arena
          </span>
        </div>
        <DayNavigator date={date} onChange={setDate} />
      </header>
      <div className="flex flex-1 overflow-hidden">
        <ArenaList selectedId={arenaId} onSelect={setArenaId} />
        {arenaId ? (
          <Timeline
            arenaId={arenaId}
            date={date}
            onEditSession={(s: Session) => setModal({ kind: 'edit', session: s })}
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
