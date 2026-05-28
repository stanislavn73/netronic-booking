interface Props {
  /** Max duration (minutes) the server reports as fittable at the current start. */
  maxFitMin: number;
  /** Capacity (typically 5) — used in the human-readable hint. */
  capacity: number;
  /** Called when the user clicks the "N min" link to lock that duration in. */
  onApply: () => void;
}

const MIN_USABLE = 5;
const MAX_USABLE_MIN = 24 * 60;

/**
 * Helper text rendered under the Duration field:
 *   - "All-clear at this start" when the full 24h is free.
 *   - "No room — pick a later time" when even 5 min wouldn't fit.
 *   - "Fits up to N min" (link to apply) otherwise.
 */
export function AvailabilityHint({ maxFitMin, capacity, onApply }: Props) {
  if (maxFitMin >= MAX_USABLE_MIN) {
    return <>All-clear at this start — fits up to 24 h.</>;
  }
  if (maxFitMin < MIN_USABLE) {
    return <span className="text-red-400">No room at this start — pick a later time.</span>;
  }
  return (
    <>
      Fits up to{' '}
      <button
        type="button"
        onClick={onApply}
        className="underline decoration-dotted text-emerald-300 hover:text-emerald-200"
      >
        {maxFitMin} min
      </button>{' '}
      without exceeding the {capacity}-session cap.
    </>
  );
}
