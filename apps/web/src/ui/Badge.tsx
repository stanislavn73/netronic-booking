import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'warning' | 'danger' | 'success';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/50',
  warning: 'bg-amber-500/15 text-amber-200 border border-amber-500/30',
  danger: 'bg-red-500/20 text-red-200 border border-red-500/40',
  success: 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30',
};

/**
 * Small pill used for capacity chips, status hints, and the like.
 */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[10px] tabular-nums',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
