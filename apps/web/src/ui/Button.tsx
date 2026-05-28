import type { ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

/**
 * Visual variants. `primary` is the affirmative action, `secondary` is the
 * neutral counterpart (Close/Cancel), `danger` is destructive (Delete),
 * `ghost` is a borderless icon-style button.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50',
  secondary:
    'border border-zinc-700 text-zinc-300 hover:bg-zinc-800',
  danger:
    'border border-red-800 text-red-300 hover:bg-red-950/40',
  ghost:
    'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200',
};

const BASE = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50';

/**
 * App-wide button primitive. Encapsulates the three visual variants so the
 * same Tailwind class string is not repeated across components.
 */
export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(BASE, VARIANT_CLASSES[variant], className)}
      {...rest}
    />
  );
}
