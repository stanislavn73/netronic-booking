import clsx from 'clsx';
import { format } from 'date-fns';
import {
  DAY_MS,
  HOUR_PX,
  LANES,
  OVERFLOW_LANE,
} from '@/components/Timeline/constants';
import type { PlacedSession } from '@/components/Timeline/lanes';

interface Props {
  session: PlacedSession;
  /** Local-midnight epoch ms of the currently displayed day. */
  dayStartMs: number;
  onClick: () => void;
}

const MIN_BLOCK_HEIGHT_PX = 18;

/**
 * One absolutely-positioned session block on the Timeline.
 *
 * Clips to `[0, DAY_MS)` so cross-midnight sessions render in-bounds with
 * "← from prev day" / "→ continues" indicators. Renders full-width red
 * when the lane assignment overflowed.
 */
export function SessionBlock({ session, dayStartMs, onClick }: Props) {
  const startAbs = +new Date(session.startTime);
  const endAbs = +new Date(session.endTime);
  const startOffsetMs = startAbs - dayStartMs;
  const endOffsetMs = endAbs - dayStartMs;
  const clippedStartMs = Math.max(0, startOffsetMs);
  const clippedEndMs = Math.min(DAY_MS, endOffsetMs);
  const top = (clippedStartMs / 3_600_000) * HOUR_PX;
  const height = Math.max(
    ((clippedEndMs - clippedStartMs) / 3_600_000) * HOUR_PX,
    MIN_BLOCK_HEIGHT_PX,
  );
  const laneWidthPct = 100 / LANES;
  const startsBeforeToday = startOffsetMs < 0;
  const endsAfterToday = endOffsetMs > DAY_MS;
  const isOverflow = session.lane === OVERFLOW_LANE;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
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
        left: isOverflow ? 0 : `${Math.max(session.lane, 0) * laneWidthPct}%`,
        width: isOverflow ? '100%' : `calc(${laneWidthPct}% - 4px)`,
        marginLeft: isOverflow ? 0 : 2,
      }}
      title={
        isOverflow
          ? 'Capacity invariant violated — see console'
          : `${format(new Date(session.startTime), 'PPpp')} → ${format(new Date(session.endTime), 'PPpp')}`
      }
    >
      {startsBeforeToday && (
        <div className="text-[10px] text-emerald-200/60">← from prev day</div>
      )}
      <div className="font-medium">
        {format(new Date(session.startTime), 'HH:mm')}–
        {format(new Date(session.endTime), 'HH:mm')}
      </div>
      {session.playerName && (
        <div className="truncate text-emerald-200/80">{session.playerName}</div>
      )}
      {endsAfterToday && (
        <div className="text-[10px] text-emerald-200/60">→ continues</div>
      )}
    </button>
  );
}
