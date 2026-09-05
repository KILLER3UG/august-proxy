import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Full-viewport modal scrim.
 *
 * Portaled to `document.body` on purpose: several overlays (the sidebar's
 * ConfirmDialog, the Bots rail's create/profile/rooms modals) are mounted
 * inside a `motion.aside` whose transform/will-change makes it a containing
 * block for `position: fixed` descendants — without the portal the "full
 * screen" veil is trapped to the sidebar's box, painting the rail milky
 * (the delete-project white-veil bug) instead of dimming the whole app.
 */
export function Backdrop({ children, onClose, className }: {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const [mountEl, setMountEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setMountEl(document.body);
    return () => setMountEl(null);
  }, []);

  const layer = (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm',
        className,
      )}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="relative">
        {children}
      </div>
    </div>
  );

  // First paint (and SSR/jsdom setup) renders inline; once mounted, portal to
  // body so the scrim escapes any transformed ancestor's containing block.
  return mountEl ? createPortal(layer, mountEl) : layer;
}
