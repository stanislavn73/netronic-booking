import { Badge, type BadgeTone } from '@/ui/Badge';
import { LANES } from '@/components/Timeline/constants';

interface Props {
  /** Peak concurrent count seen during this hour (0..LANES, possibly higher). */
  peak: number;
}

/**
 * Per-hour `n/LANES` chip rendered on the right edge of each Timeline row.
 * Color-coded so users can see at a glance which hours are saturated even
 * if the rendered session blocks leave gaps (e.g., a packed slot that's
 * actually under a long block from earlier).
 */
export function DensityChip({ peak }: Props) {
  const isFull = peak >= LANES;
  const isBusy = !isFull && peak >= LANES - 1;
  const tone: BadgeTone = isFull ? 'danger' : isBusy ? 'warning' : 'neutral';
  const title = isFull
    ? `Peak ${peak}/${LANES} — at cap somewhere in this hour, new sessions may not fit`
    : `Peak concurrent in this hour: ${peak}/${LANES}`;
  return (
    <Badge
      tone={tone}
      title={title}
      className="pointer-events-none absolute right-1 -mt-2"
    >
      {peak}/{LANES}
    </Badge>
  );
}
