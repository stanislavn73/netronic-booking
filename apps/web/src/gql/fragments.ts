import { gql } from '@apollo/client';

/** All fields on a Session needed by the UI. */
export const SESSION_FIELDS = gql`
  fragment SessionFields on Session {
    id
    arenaId
    startTime
    endTime
    durationMinutes
    playerName
    status
  }
`;

/**
 * Every field on `SlotUnavailable` needed to render the modal's error panel.
 * Inlined identically into create + update mutations — keep them in lockstep
 * here so adding a field requires editing one place.
 */
export const SLOT_UNAVAILABLE_FIELDS = gql`
  fragment SlotUnavailableFields on SlotUnavailable {
    message
    conflictingCount
    capacity
    suggestions {
      start
      end
    }
    fillsUpAt
    maxAvailableDurationMinutes
  }
`;
