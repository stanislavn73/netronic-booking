import { DensityChip } from '@/components/Timeline/DensityChip';
import { HOUR_PX } from '@/components/Timeline/constants';
import type { HourDensity } from '@/lib/concurrency';

interface Props {
  /** Length-24 array of per-hour density summaries. */
  hourly: readonly HourDensity[];
}

/**
 * 24 horizontal hour rows with their label + density chip. Stateless — the
 * click-to-create overlay and the absolutely-positioned session blocks are
 * siblings rendered by the parent Timeline.
 */
export function HourGrid({ hourly }: Props) {
  return (
    <>
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="border-t border-zinc-800/60 text-xs text-zinc-500"
          style={{ height: HOUR_PX }}
        >
          <span className="absolute -ml-12 -mt-2 w-10 text-right pr-2">
            {h.toString().padStart(2, '0')}:00
          </span>
          <DensityChip density={hourly[h] ?? { peak: 0, capFraction: 0 }} />
        </div>
      ))}
    </>
  );
}
