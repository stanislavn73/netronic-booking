import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@apollo/client';
import {
  CREATE_SESSION,
  DELETE_SESSION,
  SESSIONS_BY_ARENA,
  UPDATE_SESSION,
} from '../gql/queries';
import type { Session, SlotSuggestion } from '../lib/types';
import { dayWindow } from '../lib/date';
import { format } from 'date-fns';

const FormSchema = z.object({
  startTime: z.string().min(1),
  durationMinutes: z.coerce.number().int().min(5).max(24 * 60),
  playerName: z.string().max(120).optional(),
});
type FormData = z.infer<typeof FormSchema>;

type Mode =
  | { kind: 'create'; arenaId: string; initialStart: Date }
  | { kind: 'edit'; session: Session };

interface Props {
  mode: Mode;
  arenaId: string;
  date: Date;
  onClose: () => void;
}

function isoLocal(d: Date) {
  // datetime-local input wants "YYYY-MM-DDTHH:mm" in LOCAL time.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SessionModal({ mode, arenaId, date, onClose }: Props) {
  const isEdit = mode.kind === 'edit';
  const initial = isEdit ? new Date(mode.session.startTime) : mode.initialStart;
  const initialDuration = isEdit ? mode.session.durationMinutes : 60;

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      startTime: isoLocal(initial),
      durationMinutes: initialDuration,
      playerName: isEdit ? (mode.session.playerName ?? '') : '',
    },
  });

  const [serverError, setServerError] = useState<{
    message: string;
    suggestions?: SlotSuggestion[];
  } | null>(null);

  // Reuse the SAME dayWindow Timeline uses so Apollo's cache key matches
  // exactly — otherwise the refetch writes into a sibling cache entry and
  // the visible timeline doesn't update.
  const refetchVars = (() => {
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
  })();

  const [createMutation] = useMutation(CREATE_SESSION, refetchVars);
  const [updateMutation] = useMutation(UPDATE_SESSION, refetchVars);
  const [deleteMutation, { loading: deleting }] = useMutation(DELETE_SESSION, refetchVars);

  const onSubmit = async (form: FormData) => {
    setServerError(null);
    const start = new Date(form.startTime);
    const variables = isEdit
      ? {
          id: mode.session.id,
          input: {
            startTime: start.toISOString(),
            durationMinutes: form.durationMinutes,
            playerName: form.playerName || null,
          },
        }
      : {
          input: {
            arenaId,
            startTime: start.toISOString(),
            durationMinutes: form.durationMinutes,
            playerName: form.playerName || null,
          },
        };

    const result = isEdit
      ? await updateMutation({ variables })
      : await createMutation({ variables });

    const payload = isEdit
      ? result.data?.updateSession
      : result.data?.createSession;

    if (!payload) {
      setServerError({ message: 'Unknown error' });
      return;
    }
    if (payload.__typename === 'SessionPayload') {
      onClose();
      return;
    }
    if (payload.__typename === 'SlotUnavailable') {
      setServerError({ message: payload.message, suggestions: payload.suggestions });
      return;
    }
    if (payload.__typename === 'ValidationFailed') {
      setServerError({
        message: payload.issues.map((i: { field: string; message: string }) => `${i.field}: ${i.message}`).join('; '),
      });
      return;
    }
    if (payload.__typename === 'NotFound') {
      setServerError({ message: payload.message });
      return;
    }
  };

  const onDelete = async () => {
    if (!isEdit) return;
    if (!confirm('Cancel this session?')) return;
    await deleteMutation({ variables: { id: mode.session.id } });
    onClose();
  };

  const applySuggestion = (s: SlotSuggestion) => {
    setValue('startTime', isoLocal(new Date(s.start)));
    const durMin = Math.round((+new Date(s.end) - +new Date(s.start)) / 60_000);
    setValue('durationMinutes', durMin);
    setServerError(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 p-4">
          <h3 className="text-lg font-semibold">
            {isEdit ? 'Edit session' : 'New session'}
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 p-4">
          <div>
            <label htmlFor="session-start" className="mb-1 block text-sm text-zinc-400">
              Start time
            </label>
            <input
              id="session-start"
              type="datetime-local"
              step={60}
              {...register('startTime')}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            {errors.startTime && (
              <p className="mt-1 text-xs text-red-400">{errors.startTime.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="session-duration" className="mb-1 block text-sm text-zinc-400">
              Duration (minutes, 5–1440)
            </label>
            <input
              id="session-duration"
              type="number"
              min={5}
              max={24 * 60}
              {...register('durationMinutes')}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            {errors.durationMinutes && (
              <p className="mt-1 text-xs text-red-400">{errors.durationMinutes.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="session-player" className="mb-1 block text-sm text-zinc-400">
              Player name (optional)
            </label>
            <input
              id="session-player"
              type="text"
              {...register('playerName')}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {serverError && (
            <div className="rounded-md border border-red-900/50 bg-red-950/40 p-3 text-sm">
              <div className="font-medium text-red-300">{serverError.message}</div>
              {serverError.suggestions && serverError.suggestions.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-xs text-red-200/70">
                    Nearest available slots:
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {serverError.suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => applySuggestion(s)}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
                      >
                        {format(new Date(s.start), 'MMM d, HH:mm')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-zinc-800 pt-4">
            <div>
              {isEdit && (
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={deleting}
                  className="rounded-md border border-red-800 px-3 py-2 text-sm text-red-300 hover:bg-red-950/40"
                >
                  Cancel session
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {isEdit ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
