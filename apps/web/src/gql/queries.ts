import { gql } from '@apollo/client';

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

export const ARENAS_QUERY = gql`
  query Arenas($search: String) {
    arenas(limit: 200, search: $search) {
      id
      name
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
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      __typename
      ... on SessionPayload {
        session {
          ...SessionFields
        }
      }
      ... on SlotUnavailable {
        message
        conflictingCount
        capacity
        suggestions {
          start
          end
        }
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
  mutation UpdateSession($id: ID!, $input: UpdateSessionInput!) {
    updateSession(id: $id, input: $input) {
      __typename
      ... on SessionPayload {
        session {
          ...SessionFields
        }
      }
      ... on SlotUnavailable {
        message
        conflictingCount
        capacity
        suggestions {
          start
          end
        }
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
