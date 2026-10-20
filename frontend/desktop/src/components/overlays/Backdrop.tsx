import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { MODAL_LAYER, modalLayerClass, type ModalLayer } from './modal-layers';

/**
 * Full-viewport modal scrim.
 *
 * Portaled to `document.body` on purpose: several overlays (the sidebar's
 * ConfirmDialog, the Bots rail's create/profile/rooms modals) are mounted
 * inside a `motion.aside` whose transform/will-change makes it a containing
 * block for `position: fixed` descendants — without the portal the "full
 * screen" veil is trapped to the sidebar's box, painting the rail milky
 * (the delete-project white-veil bug) instead of dimming the whole app.
 *
 * The LAYER comes from the shared ladder (`modal-layers.ts`), not from a
 * literal here. This primitive used to hardcode `z-50`, which is how the
 * first-run setup checklist and the Settings panel ended up sharing one
 * layer — and the winner was decided by which one mounted last. Callers that
 * are an app-owned first-run surface pass `MODAL_LAYER.appOwned`; a
 * confirmation raised over anything is the default `MODAL_LAYER.prompt`.
 */
export function Backdrop({ children, onClose, className, layer = MODAL_LAYER.prompt }: {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
  /** Which rung of the modal ladder this surface sits on. */
  layer?: ModalLayer;
}) {
  const [mountEl, setMountEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setMountEl(document.body);
    return () => setMountEl(null);
  }, []);

  const layerClass = modalLayerClass(layer);

  const layerStyle = (
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center bg-foreground/40 backdrop-blur-sm',
        layerClass,
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
  return mountEl ? createPortal(layerStyle, mountEl) : layerStyle;
}
