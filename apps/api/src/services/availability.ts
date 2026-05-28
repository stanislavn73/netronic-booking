/**
 * Availability — payload shape for SLOT_UNAVAILABLE outcomes, with nearest
 * available suggestions sized to the caller's requested duration.
 *
 * Lives in services/ (not graphql/) because building the suggestion list is
 * domain logic. The GraphQL layer only maps this shape into a union variant.
 */
import { ARENA_CAPACITY } from './validation.js';
import { suggestSlots, type Slot } from './slots.js';

export interface SlotUnavailablePayload {
  message: string;
  conflictingCount: number;
  capacity: number;
  suggestions: Slot[];
  fillsUpAt: Date | null;
  maxAvailableDurationMinutes: number;
}

/**
 * Build a {@link SlotUnavailablePayload} with suggestions sized to the SAME
 * duration the caller asked for. Sizing matters: a 3-hour request must not
 * receive 1-hour suggestion chips that still hit SLOT_UNAVAILABLE on click.
 */
export async function buildSlotUnavailable(args: {
  arenaId: number;
  start: Date;
  end: Date;
  conflictingCount: number;
  fillsUpAt: Date | null;
  maxAvailableDurationMinutes: number;
}): Promise<SlotUnavailablePayload> {
  const durationMs = args.end.getTime() - args.start.getTime();
  const suggestions = await suggestSlots({
    arenaId: args.arenaId,
    preferredStart: args.start,
    durationMs,
  });
  const message = args.fillsUpAt
    ? `Slot fills up at ${args.fillsUpAt.toISOString()} — your proposal would exceed ${ARENA_CAPACITY} concurrent`
    : `Slot unavailable — ${args.conflictingCount} of ${ARENA_CAPACITY} concurrent sessions already booked`;
  return {
    message,
    conflictingCount: args.conflictingCount,
    capacity: ARENA_CAPACITY,
    suggestions,
    fillsUpAt: args.fillsUpAt,
    maxAvailableDurationMinutes: args.maxAvailableDurationMinutes,
  };
}
