/**
 * Timeline view: a single arena, single date. Renders 24 hour-rows; sessions
 * appear as absolutely-positioned blocks distributed across up to 5 lanes
 * (the capacity). Lane assignment is a greedy sweep.
 */
import { useMemo } from 'react';
import { useQuery } from '@apollo/client';
import { format, startOfDay, endOfDay, addHours } from 'date-fns';
import { SESSIONS_BY_ARENA } from '../gql/queries';
import type { Session } from '../lib/types';
import clsx from 'clsx';

const LANES = 5;
const HOUR_PX = 60;

interface Props {
  arenaId: string;
  date: Date;
  onEditSession: (s: Session) => void;
  onClickEmpty: (clickedAt: Date) => void;
}

function assignLanes(sessions: Session[]): Array<Session & { lane: number }> {
  const laneEnds: number[] = Array.from({ length: LANES }, () => 0);
  const out: Array<Session & { lane: number }> = [];
  for (const s of [...sessions].sort(
    (a, b) => +new Date(a.startTime) - +new Date(b.startTime),
  )) {
    const start = +new Date(s.startTime);
    const end = +new Date(s.endTime);
    let assigned = -1;
    for (let i = 0; i < LANES; i++) {
      if ((laneEnds[i] ?? 0) <= start) {
        assigned = i;
        laneEnds[i] = end;
        break;
      }
    }
    out.push({ ...s, lane: assigned === -1 ? 0 : assigned });
  }
  return out;
}

export function Timeline({ arenaId, date, onEditSession, onClickEmpty }: Props) {
  const from = useMemo(() => startOfDay(date), [date]);
  const to = useMemo(() => endOfDay(date), [date]);

  const { data, loading, error } = useQuery<{ sessionsByArena: Session[] }>(
    SESSIONS_BY_ARENA,
    {
      variables: { arenaId, from: from.toISOString(), to: to.toISOString() },
      fetchPolicy: 'cache-and-network',
    },
  );

  const placed = useMemo(() => assignLanes(data?.sessionsByArena ?? []), [data]);
  const totalHeight = 24 * HOUR_PX;

  const handleEmptyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hours = y / HOUR_PX;
    const clickedAt = addHours(from, hours);
    // Round to nearest 5 min for friendlier defaults
    const ms = clickedAt.getTime();
    const rounded = Math.round(ms / (5 * 60_000)) * 5 * 60_000;
    onClickEmpty(new Date(rounded));
  };

  if (error) return <div className="p-6 text-red-400">{error.message}</div>;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 p-4">
        <h2 className="text-lg font-semibold">{format(date, 'EEEE, MMM d, yyyy')}</h2>
        <span className="text-sm text-zinc-500">
          {loading ? '…' : `${placed.length} session${placed.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="relative ml-12" style={{ height: totalHeight }}>
          {/* Hour grid */}
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="border-t border-zinc-800/60 text-xs text-zinc-500"
              style={{ height: HOUR_PX }}
            >
              <span className="absolute -ml-12 -mt-2 w-10 text-right pr-2">
                {h.toString().padStart(2, '0')}:00
              </span>
            </div>
          ))}

          {/* Click-to-create overlay */}
          <div
            className="absolute inset-0 cursor-crosshair"
            onClick={handleEmptyClick}
            role="button"
            tabIndex={0}
          />

          {/* Sessions */}
          {placed.map((s) => {
            const startMs = +new Date(s.startTime) - +from;
            const endMs = +new Date(s.endTime) - +from;
            const top = (startMs / 3_600_000) * HOUR_PX;
            const height = Math.max(((endMs - startMs) / 3_600_000) * HOUR_PX, 18);
            const widthPct = 100 / LANES;
            return (
              <button
                key={s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditSession(s);
                }}
                className={clsx(
                  'absolute rounded-md border border-emerald-500/40 bg-emerald-500/20 px-2 py-1',
                  'text-left text-xs text-emerald-100 shadow-sm hover:bg-emerald-500/30 hover:border-emerald-400',
                  'transition',
                )}
                style={{
                  top,
                  height,
                  left: `${s.lane * widthPct}%`,
                  width: `calc(${widthPct}% - 4px)`,
                  marginLeft: 2,
                }}
              >
                <div className="font-medium">
                  {format(new Date(s.startTime), 'HH:mm')}–{format(new Date(s.endTime), 'HH:mm')}
                </div>
                {s.playerName && (
                  <div className="truncate text-emerald-200/80">{s.playerName}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
