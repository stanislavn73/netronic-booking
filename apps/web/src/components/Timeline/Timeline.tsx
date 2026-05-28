import { useMemo } from 'react';
import { addHours, format } from 'date-fns';
import { HOUR_PX } from '@/components/Timeline/constants';
import { HourGrid } from '@/components/Timeline/HourGrid';
import { SessionBlock } from '@/components/Timeline/SessionBlock';
import { LANES } from '@/components/Timeline/constants';
import { assignLanes } from '@/components/Timeline/lanes';
import { useDayOfSessions } from '@/hooks/useDayOfSessions';
import { hourlyDensity } from '@/lib/concurrency';
import type { Session } from '@/lib/types';

interface Props {
  arenaId: string;
  date: Date;
  onEditSession: (s: Session) => void;
  onClickEmpty: (clickedAt: Date) => void;
}

const FIVE_MIN_MS = 5 * 60_000;
const TOTAL_HEIGHT_PX = 24 * HOUR_PX;

/**
 * Single-arena, single-date timeline view. Composes:
 *   - {@link HourGrid}     — 24 hour rows + per-row density chips
 *   - {@link SessionBlock} — one absolutely-positioned block per session
 *   - a transparent overlay for click-to-create
 *
 * The day window comes from {@link useDayOfSessions} (which uses the shared
 * `dayWindow` helper), so the Apollo cache key matches the modal's refetch.
 */
export function Timeline({ arenaId, date, onEditSession, onClickEmpty }: Props) {
  const { data, loading, error, from } = useDayOfSessions(arenaId, date);
  const sessions = data?.sessionsByArena ?? [];

  const placed = useMemo(() => assignLanes(sessions), [sessions]);
  const hourly = useMemo(
    () => hourlyDensity(sessions, +from, LANES),
    [sessions, from],
  );

  if (error) return <div className="p-6 text-red-400">{error.message}</div>;

  const handleEmptyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hours = (e.clientY - rect.top) / HOUR_PX;
    // Snap to the nearest 5-min boundary for friendlier default times.
    const clickedMs = addHours(from, hours).getTime();
    const snapped = Math.round(clickedMs / FIVE_MIN_MS) * FIVE_MIN_MS;
    onClickEmpty(new Date(snapped));
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 p-4">
        <h2 className="text-lg font-semibold">{format(date, 'EEEE, MMM d, yyyy')}</h2>
        <span className="text-sm text-zinc-500">
          {loading ? '…' : `${placed.length} session${placed.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="relative ml-12" style={{ height: TOTAL_HEIGHT_PX }}>
          <HourGrid hourly={hourly} />
          <div
            className="absolute inset-0 cursor-crosshair"
            onClick={handleEmptyClick}
            role="button"
            tabIndex={0}
          />
          {placed.map((s) => (
            <SessionBlock
              key={s.id}
              session={s}
              dayStartMs={+from}
              onClick={() => onEditSession(s)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
