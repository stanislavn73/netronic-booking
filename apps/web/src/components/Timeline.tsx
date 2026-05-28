/**
 * Timeline view: a single arena, single date. Renders 24 hour-rows; sessions
 * appear as absolutely-positioned blocks distributed across up to 5 lanes
 * (the capacity). Lane assignment is a greedy sweep.
 *
 * Notes on the day window:
 *   The query uses a half-open `[from, to)` window from `dayWindow(date)`.
 *   This matches the API's tstzrange semantics: a session starting at
 *   midnight on the NEXT day is NOT included; a session ending at midnight
 *   IS included (its upper bound equals `to` but is exclusive).
 *
 * Cross-midnight sessions:
 *   The API can return sessions that started yesterday and end today, or
 *   start today and end tomorrow — they all overlap the day window. We CLIP
 *   their visual block to `[0, 24h)` of the displayed day and render small
 *   indicators ("← prev day", "→ continues") so the user knows the block is
 *   only part of the underlying session.
 */
import { useMemo } from 'react';
import { useQuery } from '@apollo/client';
import { format, addHours } from 'date-fns';
import { SESSIONS_BY_ARENA } from '../gql/queries';
import { dayWindow } from '../lib/date';
import type { Session } from '../lib/types';
import clsx from 'clsx';

const LANES = 5;
const HOUR_PX = 60;
const DAY_MS = 24 * 3_600_000;
/** Sentinel lane index for "no lane available" — invariant violation. */
const OVERFLOW_LANE = -1;

interface Props {
  arenaId: string;
  date: Date;
  onEditSession: (s: Session) => void;
  onClickEmpty: (clickedAt: Date) => void;
}

type PlacedSession = Session & { lane: number };

/**
 * Greedy lane assignment over the 5 capacity lanes.
 *
 * If a session does not fit into any of the 5 lanes (which is impossible for
 * data the API has accepted — the cap is enforced server-side), we tag it
 * with OVERFLOW_LANE and `console.error`. The render layer styles overflow
 * blocks in red so an invariant breach is visible, not silently hidden by
 * stacking on lane 0 (the old behaviour).
 */
function assignLanes(sessions: Session[]): PlacedSession[] {
  const laneEnds: number[] = Array.from({ length: LANES }, () => 0);
  const out: PlacedSession[] = [];
  for (const s of [...sessions].sort(
    (a, b) => +new Date(a.startTime) - +new Date(b.startTime),
  )) {
    const start = +new Date(s.startTime);
    const end = +new Date(s.endTime);
    let assigned = OVERFLOW_LANE;
    for (let i = 0; i < LANES; i++) {
      if ((laneEnds[i] ?? 0) <= start) {
        assigned = i;
        laneEnds[i] = end;
        break;
      }
    }
    if (assigned === OVERFLOW_LANE) {
      // eslint-disable-next-line no-console
      console.error(
        '[Timeline] capacity invariant violated — more than',
        LANES,
        'overlapping sessions for arena',
        s.arenaId,
        'at',
        new Date(start).toISOString(),
        '— DB cap may have been bypassed',
        s,
      );
    }
    out.push({ ...s, lane: assigned });
  }
  return out;
}

export function Timeline({ arenaId, date, onEditSession, onClickEmpty }: Props) {
  const { from, to } = useMemo(() => dayWindow(date), [date]);

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
            const startAbs = +new Date(s.startTime);
            const endAbs = +new Date(s.endTime);
            const fromMs = +from;

            // Clip to the displayed day so cross-midnight blocks don't
            // overflow the timeline container.
            const startOffsetMs = startAbs - fromMs;
            const endOffsetMs = endAbs - fromMs;
            const clippedStartMs = Math.max(0, startOffsetMs);
            const clippedEndMs = Math.min(DAY_MS, endOffsetMs);

            const top = (clippedStartMs / 3_600_000) * HOUR_PX;
            const height = Math.max(
              ((clippedEndMs - clippedStartMs) / 3_600_000) * HOUR_PX,
              18,
            );
            const widthPct = 100 / LANES;

            const startsBeforeToday = startOffsetMs < 0;
            const endsAfterToday = endOffsetMs > DAY_MS;
            const isOverflow = s.lane === OVERFLOW_LANE;

            return (
              <button
                key={s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditSession(s);
                }}
                className={clsx(
                  'absolute rounded-md border px-2 py-1 text-left text-xs shadow-sm transition',
                  isOverflow
                    ? 'border-red-500/60 bg-red-500/20 text-red-100 hover:bg-red-500/30'
                    : 'border-emerald-500/40 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 hover:border-emerald-400',
                )}
                style={{
                  top,
                  height,
                  // Overflow blocks render across the full width so they're impossible to miss.
                  left: isOverflow ? 0 : `${Math.max(s.lane, 0) * widthPct}%`,
                  width: isOverflow ? '100%' : `calc(${widthPct}% - 4px)`,
                  marginLeft: isOverflow ? 0 : 2,
                }}
                title={
                  isOverflow
                    ? `Capacity invariant violated — see console`
                    : `${format(new Date(s.startTime), 'PPpp')} → ${format(new Date(s.endTime), 'PPpp')}`
                }
              >
                {startsBeforeToday && (
                  <div className="text-[10px] text-emerald-200/60">← from prev day</div>
                )}
                <div className="font-medium">
                  {format(new Date(s.startTime), 'HH:mm')}–{format(new Date(s.endTime), 'HH:mm')}
                </div>
                {s.playerName && (
                  <div className="truncate text-emerald-200/80">{s.playerName}</div>
                )}
                {endsAfterToday && (
                  <div className="text-[10px] text-emerald-200/60">→ continues</div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
