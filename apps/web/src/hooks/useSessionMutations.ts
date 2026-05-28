import { useMemo } from 'react';
import { useMutation } from '@apollo/client';
import {
  CREATE_SESSION,
  DELETE_SESSION,
  SESSIONS_BY_ARENA,
  UPDATE_SESSION,
} from '@/gql/queries';
import { dayWindow } from '@/lib/date';
import type {
  Session,
  SlotUnavailablePayload,
  ValidationIssue,
} from '@/lib/types';

/**
 * Discriminated union of every variant any session mutation can return.
 * Callers should handle each `kind` explicitly.
 */
export type SessionMutationResult =
  | { kind: 'success'; session: Session }
  | { kind: 'slot_unavailable'; payload: SlotUnavailablePayload }
  | { kind: 'validation_failed'; issues: ValidationIssue[] }
  | { kind: 'not_found'; message: string }
  | { kind: 'unknown'; message: string };

interface CreateInput {
  arenaId: string;
  startTime: string;
  durationMinutes: number;
  playerName: string | null;
}

interface UpdateInput {
  id: string;
  startTime: string;
  durationMinutes: number;
  playerName: string | null;
}

/**
 * Wraps `createSession` / `updateSession` / `deleteSession` mutations and
 * collapses their `__typename`-discriminated GraphQL union into a single
 * `SessionMutationResult` so callers don't have to repeat the inline-fragment
 * dance for create + update.
 *
 * Also wires `refetchQueries` to the day-window key the Timeline uses, so
 * the visible UI updates on success without a manual cache write.
 */
export function useSessionMutations(arenaId: string, date: Date) {
  const refetch = useMemo(() => {
    const { from, to } = dayWindow(date);
    return {
      refetchQueries: [
        {
          query: SESSIONS_BY_ARENA,
          variables: {
            arenaId,
            from: from.toISOString(),
            to: to.toISOString(),
          },
        },
      ],
    };
  }, [arenaId, date]);

  const [createMutation, createState] = useMutation(CREATE_SESSION, refetch);
  const [updateMutation, updateState] = useMutation(UPDATE_SESSION, refetch);
  const [deleteMutation, deleteState] = useMutation(DELETE_SESSION, refetch);

  const create = async (input: CreateInput): Promise<SessionMutationResult> => {
    const { data } = await createMutation({ variables: { input } });
    return interpret(data?.createSession);
  };

  const update = async (input: UpdateInput): Promise<SessionMutationResult> => {
    const { id, ...patch } = input;
    const { data } = await updateMutation({ variables: { id, input: patch } });
    return interpret(data?.updateSession);
  };

  const remove = async (id: string): Promise<{ ok: boolean; message?: string }> => {
    const { data } = await deleteMutation({ variables: { id } });
    const payload = data?.deleteSession;
    if (payload?.__typename === 'SessionDeleted') return { ok: true };
    if (payload?.__typename === 'NotFound') return { ok: false, message: payload.message };
    return { ok: false, message: 'Unknown error' };
  };

  return {
    create,
    update,
    remove,
    deleting: deleteState.loading,
    creating: createState.loading,
    updating: updateState.loading,
  };
}

/** Convert a raw GraphQL payload into the discriminated SessionMutationResult. */
function interpret(payload: unknown): SessionMutationResult {
  if (!payload || typeof payload !== 'object' || !('__typename' in payload)) {
    return { kind: 'unknown', message: 'Unknown error' };
  }
  const p = payload as { __typename: string } & Record<string, unknown>;
  switch (p.__typename) {
    case 'SessionPayload':
      return { kind: 'success', session: p.session as Session };
    case 'SlotUnavailable':
      return { kind: 'slot_unavailable', payload: p as unknown as SlotUnavailablePayload };
    case 'ValidationFailed':
      return { kind: 'validation_failed', issues: p.issues as ValidationIssue[] };
    case 'NotFound':
      return { kind: 'not_found', message: String(p.message ?? '') };
    default:
      return { kind: 'unknown', message: `Unhandled __typename: ${p.__typename}` };
  }
}
