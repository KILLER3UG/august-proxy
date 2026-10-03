import { useEffect } from 'react';

/**
 * Escape-to-close for a non-modal overlay (menus, popovers, banners).
 *
 * Contract: ONE Escape press closes ONE layer. The listener runs at the
 * document level and calls `stopPropagation()`, so an enclosing overlay's
 * own window-level handler (Settings, the right drawer) does not also fire —
 * that double-fire used to dismiss a nested dialog *and* the whole panel.
 */
export function BackdropEscape({ onEscape }: { onEscape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
  return null;
}