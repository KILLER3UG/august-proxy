/* ── useFocusTrap — keyboard focus containment for modal overlays ────── */
/* Traps Tab/Shift+Tab inside the dialog, moves focus to the first
 * focusable on mount, and restores focus to the previously-focused
 * element on unmount (audit finding: dialogs lacked consistent focus
 * management). Attach the returned ref to the overlay root.
 *
 * ── The root is READ, never captured ──────────────────────────────────────
 *
 * The trap used to read `ref.current` ONCE, when its effect ran, and hold
 * that node for the rest of its life. A root that is REPLACED while the
 * trap is live — React re-creating the element because its type or its key
 * changed — leaves the trap holding a DETACHED node: `querySelectorAll` on
 * it finds nothing, so the Tab wrapping does nothing at all while the
 * dialog still advertises `aria-modal="true"`. That is the same failure the
 * `Backdrop` primitive had (it used to portal on the next tick, so every
 * trap captured the inline copy that was then unmounted), one level down,
 * and it was still there for every trap in the app.
 *
 * So the root is read LIVE — on every key press, and again after every
 * render — and a replaced root is RE-ANCHORED: the focus that sat inside
 * the old node is now on a detached element, and the trap's promise ("focus
 * lives inside the dialog") is re-asserted against the new node. A root
 * that is REMOVED leaves the trap with nothing to contain: it stops acting
 * rather than grabbing focus for a dialog that is no longer there, and it
 * picks the trap back up if a root arrives again.
 *
 * ── ONE trap owns the press ──────────────────────────────────────────────
 *
 * Two armed traps (the Settings panel, and a dialog raised over it) both
 * see the same Tab press. The INNER one owns it: the focused element is
 * inside the inner trap's marked root, so the outer trap stands down
 * instead of yanking focus back into itself. Without that, Tab inside the
 * raised dialog jumped to its FIRST control every time — the outer trap
 * moved focus out of the dialog, and the inner trap then found the focus
 * outside itself and pulled it to the top.
 */

import { useEffect, useRef } from 'react';

/** Focusable descendants, in DOM order.
 *
 *  `[disabled]` is excluded on purpose: a disabled button is not in the
 *  tab order, and treating it as the LAST focusable made the trap wrap
 *  onto a control that cannot take focus (the PromptDialog's "Save" button
 *  while the field is empty), so Tab walked OUT of the dialog instead of
 *  wrapping inside it. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Marks the root of an ARMED trap. The marker is how a trap recognises
 *  that the focused element belongs to a DIFFERENT (inner) trap. */
const TRAP_MARKER = 'data-august-focus-trap';

/** The focusable descendants of `root`, in DOM order. */
function focusablesWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** Move focus to the first focusable inside `root` — unless focus is
 *  already inside it. */
function focusFirstWithin(root: HTMLElement): void {
  const first = focusablesWithin(root)[0];
  if (!first) return;
  const current = document.activeElement;
  if (current instanceof HTMLElement && root.contains(current)) return;
  first.focus();
}

/** The innermost armed trap that owns `element`, if any. */
function owningTrap(element: Element | null): Element | null {
  return element instanceof Element ? element.closest(`[${TRAP_MARKER}]`) : null;
}

/** Move the trap marker onto `root`, off the previous one, or off the DOM
 *  entirely (`root === null`). */
function markTrapRoot(
  marked: { current: HTMLElement | null },
  root: HTMLElement | null,
): void {
  if (marked.current === root) return;
  marked.current?.removeAttribute(TRAP_MARKER);
  if (root) root.setAttribute(TRAP_MARKER, '');
  marked.current = root;
}

export function useFocusTrap<T extends HTMLElement>(active = true) {
  const ref = useRef<T | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  /** The root this trap is bound to RIGHT NOW: `undefined` = not observed
   *  yet, `null` = the root is gone. */
  const boundRoot = useRef<T | null | undefined>(undefined);
  /** The element currently carrying the trap marker. */
  const markedRoot = useRef<HTMLElement | null>(null);

  /* A node swap IS a render, and React re-attaches the ref during the
   * commit — so this effect (which runs after EVERY render of the owner)
   * is where a replaced root is noticed. The root is re-read from
   * `ref.current` here, and the marker moves with it. */
  useEffect(() => {
    if (!active) {
      boundRoot.current = undefined;
      return;
    }
    const root = ref.current;
    // The marker is (re)asserted on EVERY render, not only when the root
    // changes: the trap effect below takes the marker off again when it
    // disarms, and a trap that re-arms (React's StrictMode runs an effect
    // twice on mount) must put it back — without it, two armed traps would
    // fight over one Tab press.
    markTrapRoot(markedRoot, root);
    if (root === boundRoot.current) return;
    const previous = boundRoot.current;
    boundRoot.current = root ?? null;
    // The FIRST observation is the mount: the trap effect below already
    // moved focus in and recorded where to restore it.
    if (previous === undefined) return;
    // The root was REPLACED (or removed and a new one arrived). Focus that
    // sat inside the old node is now on a detached element, so the trap's
    // promise — focus lives inside the dialog — is re-asserted against the
    // new root.
    if (root && root.isConnected) focusFirstWithin(root);
  });

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement;

    // Move focus into the dialog (first focusable) on open.
    const root = ref.current;
    if (root) focusFirstWithin(root);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // The LIVE root: it may have been replaced since the trap was armed.
      const root = ref.current;
      if (!root || !root.isConnected) return;
      // An INNER trap owns this press. A dialog raised over this one has
      // its own focus, and two traps fighting over one Tab press is how a
      // dialog's Tab order collapsed onto its first control.
      const owner = owningTrap(document.activeElement);
      if (owner && owner !== root) return;
      const list = focusablesWithin(root);
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === firstEl || !(activeEl instanceof Node) || !root.contains(activeEl)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else if (activeEl === lastEl || !(activeEl instanceof Node) || !root.contains(activeEl)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      markTrapRoot(markedRoot, null);
      // Restore focus to wherever the user was before the overlay opened.
      const back = previouslyFocused.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [active]);

  return ref;
}
