/**
 * ConfirmDialog — reusable styled confirmation modal.
 * Replaces native window.confirm() with a design-consistent dialog.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Backdrop } from '@/components/overlays/Backdrop';
import { BackdropEscape } from '@/components/overlays/BackdropEscape';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'neutral';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'neutral',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Escape closes exactly this layer. BackdropEscape listens on document
  // CAPTURE and stops propagation, so the enclosing surface's own
  // window-level handler (Settings, the right drawer) cannot also fire.
  // A window-bubble listener with stopPropagation could not do that —
  // same-target listeners still run, which is how one Escape used to close
  // both the confirm and Settings (live-checked 2026-10-04).
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  const handleConfirm = useCallback(() => {
    onConfirm();
  }, [onConfirm]);

  if (!open) return null;

  return (
    <Backdrop onClose={onCancel} className="z-[70]">
      <BackdropEscape onEscape={onCancel} />
      <div
        className={cn(
          'w-[min(92vw,400px)] rounded-2xl border border-border bg-card shadow-2xl',
          'px-5 pt-5 pb-4',
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        data-testid="confirm-dialog"
      >
        <h2
          id="confirm-dialog-title"
          className="text-[0.9375rem] font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        <p className="mt-1.5 text-[0.8125rem] text-muted-foreground leading-relaxed">
          {message}
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'rounded-lg border border-border px-3.5 py-1.5 text-[0.8125rem] font-medium',
              'text-foreground/90 hover:bg-accent transition',
            )}
          >
            {cancelLabel}
            <span className="ml-1.5 text-muted-foreground/60 text-2xs">Esc</span>
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[0.8125rem] font-medium transition',
              variant === 'destructive'
                ? 'bg-danger text-white hover:bg-danger'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
