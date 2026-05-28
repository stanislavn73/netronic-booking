import { Badge, type BadgeTone } from '@/ui/Badge';
import { LANES } from '@/components/Timeline/constants';
import type { HourDensity } from '@/lib/concurrency';

interface Props {
  density: HourDensity;
}

/** Bottom of the "briefly at cap" tier — below this, treat as roomy. */
const BUSY_FRACTION = 0.1;
/** Bottom of the "mostly at cap" tier — above this, the row is saturated. */
const FULL_FRACTION = 0.5;

/**
 * Per-hour `n/LANES` chip rendered on the right edge of each Timeline row.
 *
 * The number is the peak concurrent count seen in the hour; the COLOUR is
 * driven by how much of the hour was actually at cap. A one-minute spike to
 * 5 in an otherwise-quiet hour stays neutral, not red — matches what the
 * user sees in the rendered session blocks.
 *
 * Tone tiers:
 *   - peak < cap                          → neutral ("there's always room here")
 *   - peak ≥ cap, < 10% of hour at cap    → neutral (brief spike)
 *   - peak ≥ cap, 10–50% of hour at cap   → warning (worth a glance)
 *   - peak ≥ cap, ≥ 50% of hour at cap    → danger (mostly saturated)
 */
export function DensityChip({ density }: Props) {
  const { peak, capFraction } = density;
  const fractionPct = Math.round(capFraction * 100);
  const tone: BadgeTone = pickTone(peak, capFraction);
  const title =
    peak < LANES
      ? `Peak concurrent in this hour: ${peak}/${LANES}`
      : capFraction === 0
        ? `Peak concurrent in this hour: ${peak}/${LANES}`
        : `Peaks ${peak}/${LANES} — at cap for ${fractionPct}% of this hour`;
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

function pickTone(peak: number, capFraction: number): BadgeTone {
  if (peak < LANES) return 'neutral';
  if (capFraction < BUSY_FRACTION) return 'neutral';
  if (capFraction < FULL_FRACTION) return 'warning';
  return 'danger';
}
