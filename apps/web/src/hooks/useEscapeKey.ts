import { useEffect } from 'react';

/**
 * Calls `onEscape` when the user presses the Escape key. Listens at the
 * window level; safe to mount multiple times (each modal owns its own).
 */
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onEscape]);
}
