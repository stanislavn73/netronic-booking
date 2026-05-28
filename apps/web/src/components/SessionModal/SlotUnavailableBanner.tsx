import { formatLocalHm, formatLocalShort } from '@/lib/date';
import type { SlotSuggestion, SlotUnavailablePayload } from '@/lib/types';

interface Props {
  /** Either the SlotUnavailable payload from a mutation, or a free-text error. */
  error:
    | { kind: 'slot_unavailable'; payload: SlotUnavailablePayload }
    | { kind: 'message'; message: string };
  /** Apply a suggested alternative slot to the form. */
  onApplySuggestion: (s: SlotSuggestion) => void;
  /** Apply just the fittable duration (keeping the current start). */
  onApplyMaxFit: (minutes: number) => void;
}

/**
 * Red panel below the form fields when a mutation fails. Renders either a
 * plain message (validation / not-found / unknown) or the rich
 * SlotUnavailable variant with `fillsUpAt`, "Try N min instead", and the
 * suggestion chips returned by the server.
 */
export function SlotUnavailableBanner({ error, onApplySuggestion, onApplyMaxFit }: Props) {
  if (error.kind === 'message') {
    return (
      <div className="rounded-md border border-red-900/50 bg-red-950/40 p-3 text-sm">
        <div className="font-medium text-red-300">{error.message}</div>
      </div>
    );
  }
  const { payload } = error;
  return (
    <div className="rounded-md border border-red-900/50 bg-red-950/40 p-3 text-sm">
      <div className="font-medium text-red-300">{payload.message}</div>
      {payload.fillsUpAt && (
        <div className="mt-1 text-xs text-red-200/80">
          Slot fills at <span className="font-mono">{formatLocalHm(payload.fillsUpAt)}</span>.
          {payload.maxAvailableDurationMinutes >= 5 && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => onApplyMaxFit(payload.maxAvailableDurationMinutes)}
                className="underline decoration-dotted text-emerald-300 hover:text-emerald-200"
              >
                Try {payload.maxAvailableDurationMinutes} min instead
              </button>
            </>
          )}
        </div>
      )}
      {payload.suggestions.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-red-200/70">Nearest available slots:</div>
          <div className="flex flex-wrap gap-2">
            {payload.suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onApplySuggestion(s)}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
              >
                {formatLocalShort(s.start)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
