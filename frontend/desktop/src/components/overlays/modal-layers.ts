/* ── modal-layers — the app's full-screen surface ladder ──────────────────
 *
 * Every surface that covers the whole app claims a layer from THIS file, so
 * "which one is on top" is a property of intent and never of mount order.
 *
 * Why it exists (measured, not assumed): the first-run setup checklist and the
 * Settings panel both claimed `z-50`. App.tsx mounts the checklist AFTER the
 * routes, so it painted over the entire Settings panel and swallowed every
 * click in it — in Chromium, `document.elementFromPoint` at the "Chat font"
 * listbox returned the checklist's own backdrop instead of the button, and a
 * real click timed out. Two surfaces sharing one layer is the defect: the
 * winner was decided by DOM order, so the next surface to mount would have
 * inherited the same bug. The ladder is the fix; the layering is now declared.
 *
 * The order is by INTENT, not by importance:
 *
 *   appOwned  — a surface the app put up by itself (the first-run surfaces).
 *   userOwned — a surface the user navigated to (the Settings panel).
 *   dialog    — a modal DIALOG raised over one of those (the model editor).
 *   prompt    — a confirmation raised ON TOP of any of them.
 *
 * A user-owned surface is ABOVE an app-owned one, because the user asked for
 * it: the first-run surfaces yield to it (see `useUserOwnedPanelOpen`).
 *
 * A `dialog` sits ABOVE the surface it was opened from and BELOW a
 * `prompt` raised over it, and both halves matter. The editor used to sit
 * on a hardcoded `z-[80]`, ABOVE the prompt rung — so a confirmation
 * raised over it (the quit-confirm, a delete-confirm) rendered UNDERNEATH
 * the editor's own scrim and was invisible. On the `dialog` rung the
 * editor is above the panel it came from and below every confirmation, so
 * the two can no longer be ordered by whichever mounted last.
 */

export const MODAL_LAYER = {
  appOwned: 50,
  userOwned: 60,
  dialog: 65,
  prompt: 70,
} as const;

export type ModalLayer = (typeof MODAL_LAYER)[keyof typeof MODAL_LAYER];

/** The Tailwind z-index class per layer.
 *
 *  Written out as literals rather than computed, because Tailwind's scanner
 *  reads the SOURCE: a `z-[${n}]` template would emit nothing at all, which is
 *  how several classes in this tree once became invisible. */
const LAYER_CLASS: Record<ModalLayer, string> = {
  50: 'z-50',
  60: 'z-[60]',
  65: 'z-[65]',
  70: 'z-[70]',
};

export function modalLayerClass(layer: ModalLayer): string {
  return LAYER_CLASS[layer];
}

/** True when a USER-OWNED full-screen panel owns the screen.
 *
 *  The Settings panel is the app's one route-owned panel: the user opened it,
 *  so it is the surface that must work. An app-owned first-run surface has to
 *  step aside for it — and it comes back when the user leaves, so following one
 *  of its own links is not a dead end. */

import { useLocation } from 'react-router-dom';
export function isUserOwnedPanelRoute(pathname: string): boolean {
  return pathname.toLowerCase().startsWith('/settings');
}

/** True while a user-owned full-screen panel owns the screen.
 *
 *  An app-owned first-run surface asks this and steps aside: it stops
 *  rendering AND releases its focus trap, so the panel the user navigated to
 *  is the one that works. The surface is not dismissed — it comes back when
 *  the user leaves, so following one of its links is a hand-off, not a dead
 *  end. */
export function useUserOwnedPanelOpen(): boolean {
  return isUserOwnedPanelRoute(useLocation().pathname);
}
