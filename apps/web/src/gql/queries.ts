import { gql } from '@apollo/client';
import { SESSION_FIELDS, SLOT_UNAVAILABLE_FIELDS } from '@/gql/fragments';

// Re-export so historical imports of `SESSION_FIELDS` from this file still work.
export { SESSION_FIELDS, SLOT_UNAVAILABLE_FIELDS };

export const ARENAS_QUERY = gql`
  query Arenas($search: String) {
    arenas(limit: 200, search: $search) {
      id
      name
    }
  }
`;

/**
 * Probes occupancy at a proposed start. Returns peak-concurrent count, the
 * largest duration that would fit at this start, and the first instant the
 * cap is reached (if any). Used by the modal's "Fits up to N min" helper.
 */
export const CHECK_AVAILABILITY = gql`
  query CheckAvailability(
    $arenaId: ID!
    $startTime: DateTime!
    $durationMinutes: Int!
  ) {
    checkAvailability(
      arenaId: $arenaId
      startTime: $startTime
      durationMinutes: $durationMinutes
    ) {
      available
      conflictingCount
      capacity
      maxAvailableDurationMinutes
      fillsUpAt
    }
  }
`;

export const SESSIONS_BY_ARENA = gql`
  ${SESSION_FIELDS}
  query SessionsByArena($arenaId: ID!, $from: DateTime!, $to: DateTime!) {
    sessionsByArena(arenaId: $arenaId, from: $from, to: $to) {
      ...SessionFields
    }
  }
`;

export const CREATE_SESSION = gql`
  ${SESSION_FIELDS}
  ${SLOT_UNAVAILABLE_FIELDS}
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      __typename
      ... on SessionPayload {
        session {
          ...SessionFields
        }
      }
      ... on SlotUnavailable {
        ...SlotUnavailableFields
      }
      ... on ValidationFailed {
        issues {
          field
          message
        }
      }
      ... on NotFound {
        message
      }
    }
  }
`;

export const UPDATE_SESSION = gql`
  ${SESSION_FIELDS}
  ${SLOT_UNAVAILABLE_FIELDS}
  mutation UpdateSession($id: ID!, $input: UpdateSessionInput!) {
    updateSession(id: $id, input: $input) {
      __typename
      ... on SessionPayload {
        session {
          ...SessionFields
        }
      }
      ... on SlotUnavailable {
        ...SlotUnavailableFields
      }
      ... on ValidationFailed {
        issues {
          field
          message
        }
      }
      ... on NotFound {
        message
      }
    }
  }
`;

export const DELETE_SESSION = gql`
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id) {
      __typename
      ... on SessionDeleted {
        id
      }
      ... on NotFound {
        message
      }
    }
  }
`;
