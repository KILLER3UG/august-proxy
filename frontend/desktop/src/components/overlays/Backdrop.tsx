import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { MODAL_LAYER, modalLayerClass, type ModalLayer } from './modal-layers';
import { useFocusTrap } from '@/hooks/useFocusTrap';

/** The scrim the user is actually looking at: the highest stacking value
 *  wins, and within one layer the newest mounted wins (document order). */
function topmostScrim(): HTMLElement | null {
  const scrims = Array.from(
    document.querySelectorAll<HTMLElement>('[data-august-backdrop]'),
  );
  let top: HTMLElement | null = null;
  for (const scrim of scrims) {
    if (!top) {
      top = scrim;
      continue;
    }
    const z = Number.parseInt(getComputedStyle(scrim).zIndex, 10) || 0;
    const topZ = Number.parseInt(getComputedStyle(top).zIndex, 10) || 0;
    // `>=`, so a tie goes to the NEWER scrim (document order) — that is the
    // nested case, where the inner modal is on top of its parent.
    if (z >= topZ) top = scrim;
  }
  return top;
}

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
 *
 * ── What the scrim is, and what it is not ────────────────────────────────
 *
 * The scrim is a PLAIN DIV. It carries no `role` and no `aria-modal`,
 * because those belong to the DIALOG — the box the caller renders as a
 * child. A `role="dialog"` on the scrim would announce the whole viewport
 * as one dialog and make the real dialog inside it a child dialog. Every
 * call site already puts `role="dialog" aria-modal="true"` (plus a name)
 * on the inner box; that is the correct shape and it is unchanged here.
 *
 * ── Escape ──────────────────────────────────────────────────────────────
 *
 * Should Escape close a dismissible scrim? YES. A modal that cannot be
 * dismissed from the keyboard is a keyboard trap, and every one of these
 * surfaces has a visible "Close" affordance that Escape is expected to
 * mirror. The refusal case is real too — the first-run setup checklist is
 * deliberately NOT dismissible, because a stray click must not throw away
 * a half-finished setup — and it refuses by passing NO `onClose`. A caller
 * that wants a scrim it can click away but will not let Escape close it
 * passes `closeOnEscape={false}`.
 *
 * Exactly ONE layer closes per Escape press. Three rules make that true:
 *
 *  1. The handler runs at the DOCUMENT CAPTURE phase, so it is reached
 *     before any bubble-phase listener (the right drawer's, the model-edit
 *     modal's) and stops the event from reaching them at all.
 *  2. It bails when `defaultPrevented` is already set — a surface that owns
 *     Escape itself (`BackdropEscape`, the shortcuts modal) has claimed the
 *     press, so the scrim must not also act.
 *  3. It bails unless it is the TOPMOST scrim — the one on the highest
 *     rung of the modal ladder, and the newest within that rung. A nested
 *     scrim (the room-settings modal inside the group-rooms modal) closes
 *     first and must not take its parent with it; and a scrim that refuses
 *     the dismiss keeps the press to itself rather than letting a lower
 *     layer close behind it.
 *
 * ── Focus ───────────────────────────────────────────────────────────────
 *
 * `trapFocus` opts this primitive into the app's own focus-trap helper
 * (`useFocusTrap`): Tab/Shift+Tab cycle inside the dialog, focus moves in
 * on open and returns to the opener on close. It is OFF by default because
 * a trap is a behaviour change — a surface that already owns its trap (the
 * shortcuts modal, the quit-confirm modal, the command palette) must not
 * get a second one.
 */
export function Backdrop({
  children,
  onClose,
  className,
  layer = MODAL_LAYER.prompt,
  closeOnEscape,
  trapFocus = false,
}: {
  children: ReactNode;
  /**
   * Click-to-dismiss. OMIT it for a scrim that must not be dismissible at
   * all (the first-run setup checklist) — with no `onClose` there is
   * nothing for a click or an Escape to close.
   */
  onClose?: () => void;
  className?: string;
  /** Which rung of the modal ladder this surface sits on. */
  layer?: ModalLayer;
  /**
   * Whether Escape closes the scrim. Defaults to YES for a dismissible
   * scrim (one with an `onClose`); pass `false` to refuse the dismiss and
   * keep Escape for something else.
   */
  closeOnEscape?: boolean;
  /**
   * Trap Tab inside the dialog and move focus into it on open. Default:
   * no — a caller that already owns a trap must not get a second one.
   */
  trapFocus?: boolean;
}) {
  // The portal target is resolved ONCE, on the first render, and the tree is
  // portaled immediately. It used to render inline first and portal on the
  // next tick, which REMOUNTED the whole subtree: the inline copy was
  // unmounted and a fresh copy mounted into the portal. Every focus trap
  // that lives in the CALL SITE (`useFocusTrap` attached to the dialog, as
  // the shortcuts modal, the quit-confirm modal, the command palette and
  // the setup checklist do) captured the FIRST, now-detached copy as its
  // root — so `focusables()` came back empty and the trap did nothing at
  // all, while the dialog still advertised `aria-modal="true"`. Portaling
  // straight away keeps one live copy and makes those traps real.
  const [mountEl] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.body,
  );
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(trapFocus);

  const escapeCloses = closeOnEscape ?? Boolean(onClose);
  // Held in a ref so the listener is registered ONCE: re-registering on
  // every render would move this handler behind `BackdropEscape` in the
  // document's listener list, and both would then fire on one Escape.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A surface that owns Escape itself already handled this press.
      if (e.defaultPrevented) return;
      const scrim = scrimRef.current;
      if (!scrim) return;
      // Only the TOPMOST scrim owns Escape, so a nested one closes alone and
      // a scrim that refuses the dismiss keeps the press to itself. "Topmost"
      // is the modal ladder's order — the highest stacking value wins, and
      // within one layer the newest mounted wins. Comparing the RENDERED
      // z-index (not the mount order) matters: the first-run checklist is
      // app-owned (z-50) and can mount after a prompt-layer surface
      // (z-70), and the prompt surface is the one the user can see.
      if (topmostScrim() !== scrim) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [escapeCloses]);

  const layerClass = modalLayerClass(layer);

  const layerStyle = (
    <div
      ref={scrimRef}
      data-august-backdrop=""
      className={cn(
        /* `bg-scrim` is the app's OWN scrim token (`--dt-overlay-scrim`: 32%
         * over the light ground, 55% over the dark one) and the class the
         * settings panel's own backdrop already uses.
         *
         * This was `bg-foreground/40`, which is a 40% wash of the FOREGROUND
         * colour -- and the foreground is near-WHITE in dark mode, so the
         * scrim inverted the app's brightness: a dark app behind a modal was
         * washed out to a light grey, and the modal read as if the whole
         * product had switched to light mode. The token is the veil the
         * reference shows: the chat is DIMMED behind the panel, not
         * bleached. */
        'fixed inset-0 flex items-center justify-center bg-scrim backdrop-blur-sm',
        layerClass,
        className,
      )}
      onClick={onClose}
    >
      <div ref={trapRef} onClick={(e) => e.stopPropagation()} className="relative">
        {children}
      </div>
    </div>
  );

  return mountEl ? createPortal(layerStyle, mountEl) : layerStyle;
}
