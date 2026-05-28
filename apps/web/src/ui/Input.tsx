import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import clsx from 'clsx';

const BASE =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none';

/**
 * Text/datetime/number input primitive. Forwards refs so it works as the
 * target of `react-hook-form`'s `register()` output.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={clsx(BASE, className)} {...rest} />;
  },
);
