/**
 * useConfirmDialog — hook that replaces window.confirm() with a styled dialog.
 *
 * Usage:
 *   const confirm = useConfirmDialog();
 *   const ok = await confirm({ title: 'Delete?', message: 'This cannot be undone.' });
 *   if (ok) doDelete();
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'neutral';
}

export interface ConfirmDialogState extends ConfirmDialogOptions {
  open: boolean;
  resolve: ((value: boolean) => void) | null;
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    resolve: null,
  });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    resolveRef.current?.(true);
    resolveRef.current = null;
    setState((s) => ({ ...s, open: false, resolve: null }));
  }, []);

  const handleCancel = useCallback(() => {
    resolveRef.current?.(false);
    resolveRef.current = null;
    setState((s) => ({ ...s, open: false, resolve: null }));
  }, []);

  // Safety net: if the owning component unmounts while a confirm is still
  // open (e.g. a delete navigates away mid-dialog), resolve the pending
  // promise as `false` so an awaiting caller's continuation completes instead
  // of hanging forever on a dialog that is gone. Without this, a stranded
  // `await confirm()` can leave the delete flow half-run.
  useEffect(() => {
    return () => {
      resolveRef.current?.(false);
      resolveRef.current = null;
    };
  }, []);

  return { state, confirm, handleConfirm, handleCancel };
}
