import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/ui/Button';
import { Field } from '@/ui/Field';
import { Input } from '@/ui/Input';
import { Modal } from '@/ui/Modal';
import { AvailabilityHint } from '@/components/SessionModal/AvailabilityHint';
import { SlotUnavailableBanner } from '@/components/SessionModal/SlotUnavailableBanner';
import {
  SessionFormSchema,
  type SessionFormData,
} from '@/components/SessionModal/schema';
import { useAvailabilityProbe } from '@/hooks/useAvailabilityProbe';
import { useSessionMutations } from '@/hooks/useSessionMutations';
import {
  datetimeLocalToIso,
  toDatetimeLocalValue,
} from '@/lib/date';
import type {
  Session,
  SlotSuggestion,
  SlotUnavailablePayload,
} from '@/lib/types';

export type SessionModalMode =
  | { kind: 'create'; arenaId: string; initialStart: Date }
  | { kind: 'edit'; session: Session };

interface Props {
  mode: SessionModalMode;
  arenaId: string;
  date: Date;
  onClose: () => void;
}

type ErrorState =
  | { kind: 'slot_unavailable'; payload: SlotUnavailablePayload }
  | { kind: 'message'; message: string }
  | null;

const DEFAULT_DURATION_MIN = 60;

/**
 * Create / edit session modal.
 *
 * Composition only — the form layout, availability probing, and mutation
 * plumbing all live in {@link SessionForm}, {@link useAvailabilityProbe},
 * and {@link useSessionMutations} respectively.
 */
export function SessionModal({ mode, arenaId, date, onClose }: Props) {
  const isEdit = mode.kind === 'edit';
  const initialStart = isEdit ? new Date(mode.session.startTime) : mode.initialStart;
  const initialDuration = isEdit ? mode.session.durationMinutes : DEFAULT_DURATION_MIN;

  const form = useForm<SessionFormData>({
    resolver: zodResolver(SessionFormSchema),
    defaultValues: {
      startTime: toDatetimeLocalValue(initialStart),
      durationMinutes: initialDuration,
      playerName: isEdit ? (mode.session.playerName ?? '') : '',
    },
  });
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form;

  const currentStartIso = useMemo(
    () => datetimeLocalToIso(watch('startTime')),
    [watch('startTime')],
  );
  const { data: availability } = useAvailabilityProbe(arenaId, currentStartIso);
  const maxFitMin = availability?.maxAvailableDurationMinutes;

  // On NEW sessions, when the probe first reports back, lower the default
  // duration to what would actually fit. The modal opens to a submittable
  // form even when the user clicked an almost-full slot.
  const [didAutoFit, setDidAutoFit] = useState(false);
  useEffect(() => {
    if (isEdit || didAutoFit || maxFitMin == null) return;
    if (maxFitMin >= 5 && maxFitMin < initialDuration) {
      setValue('durationMinutes', maxFitMin);
    }
    setDidAutoFit(true);
  }, [isEdit, didAutoFit, maxFitMin, initialDuration, setValue]);

  const [error, setError] = useState<ErrorState>(null);
  const { create, update, remove, deleting } = useSessionMutations(arenaId, date);

  const onSubmit = handleSubmit(async (data) => {
    setError(null);
    const startIso = new Date(data.startTime).toISOString();
    const result = isEdit
      ? await update({
          id: mode.session.id,
          startTime: startIso,
          durationMinutes: data.durationMinutes,
          playerName: data.playerName || null,
        })
      : await create({
          arenaId,
          startTime: startIso,
          durationMinutes: data.durationMinutes,
          playerName: data.playerName || null,
        });
    switch (result.kind) {
      case 'success':
        onClose();
        return;
      case 'slot_unavailable':
        setError({ kind: 'slot_unavailable', payload: result.payload });
        return;
      case 'validation_failed':
        setError({
          kind: 'message',
          message: result.issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        });
        return;
      case 'not_found':
      case 'unknown':
        setError({ kind: 'message', message: result.message });
        return;
    }
  });

  const onDelete = async () => {
    if (!isEdit) return;
    if (!confirm('Delete this session?')) return;
    await remove(mode.session.id);
    onClose();
  };

  const applySuggestion = (s: SlotSuggestion) => {
    setValue('startTime', toDatetimeLocalValue(new Date(s.start)));
    const durMin = Math.round((+new Date(s.end) - +new Date(s.start)) / 60_000);
    setValue('durationMinutes', durMin);
    setError(null);
  };

  const applyMaxFit = (minutes: number) => {
    if (minutes < 5) return;
    setValue('durationMinutes', minutes);
    setError(null);
  };

  return (
    <Modal title={isEdit ? 'Edit session' : 'New session'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4 p-4">
        <Field
          label="Start time"
          htmlFor="session-start"
          error={errors.startTime?.message}
        >
          <Input
            id="session-start"
            type="datetime-local"
            step={60}
            {...register('startTime')}
          />
        </Field>

        <Field
          label="Duration (minutes, 5–1440)"
          htmlFor="session-duration"
          error={errors.durationMinutes?.message}
          hint={
            availability && maxFitMin != null ? (
              <AvailabilityHint
                maxFitMin={maxFitMin}
                capacity={availability.capacity}
                onApply={() => applyMaxFit(maxFitMin)}
              />
            ) : null
          }
        >
          <Input
            id="session-duration"
            type="number"
            min={5}
            max={24 * 60}
            {...register('durationMinutes')}
          />
        </Field>

        <Field label="Player name (optional)" htmlFor="session-player">
          <Input id="session-player" type="text" {...register('playerName')} />
        </Field>

        {error && (
          <SlotUnavailableBanner
            error={error}
            onApplySuggestion={applySuggestion}
            onApplyMaxFit={applyMaxFit}
          />
        )}

        <div className="flex items-center justify-between border-t border-zinc-800 pt-4">
          <div>
            {isEdit && (
              <Button variant="danger" onClick={onDelete} disabled={deleting}>
                Delete session
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
