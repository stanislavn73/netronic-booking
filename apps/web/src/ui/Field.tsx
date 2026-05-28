import type { ReactNode } from 'react';

interface FieldProps {
  /** Label text shown above the input. */
  label: string;
  /** `htmlFor` target — should match the wrapped input's `id`. */
  htmlFor: string;
  /** RHF error message; rendered in red below the input when set. */
  error?: string;
  /** Optional helper text rendered below the input (and below the error). */
  hint?: ReactNode;
  /** The input/select/textarea itself. */
  children: ReactNode;
}

/**
 * Label + control + error + hint, the typical form-field layout. Lets each
 * call site drop the repeated `<label>` + `<p>` boilerplate.
 */
export function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm text-zinc-400">
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}
