import type { ReactNode } from 'react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Button } from '@/ui/Button';

interface ModalProps {
  /** Heading text rendered in the modal header. */
  title: string;
  /** Closes the modal — wired to the × button and the Escape key. */
  onClose: () => void;
  /** Modal body. */
  children: ReactNode;
}

/**
 * Centered overlay modal with title bar + close button + ESC handling.
 *
 * Does NOT include a focus trap — for the current single-modal app that's
 * acceptable; revisit if multi-step or nested modals are added.
 */
export function Modal({ title, onClose, children }: ModalProps) {
  useEscapeKey(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 p-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <Button variant="ghost" onClick={onClose} aria-label="Close" className="!px-2 !py-1">
            ×
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
