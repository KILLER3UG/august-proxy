/* ── useFocusTrap — keyboard focus containment for modal overlays ────── */
/* Traps Tab/Shift+Tab inside the dialog, moves focus to the first
 * focusable on mount, and restores focus to the previously-focused
 * element on unmount (audit finding: dialogs lacked consistent focus
 * management). Attach the returned ref to the overlay root. */

import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(active = true) {
  const ref = useRef<T | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement;

    const root = ref.current;
    if (!root) return;

    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the dialog (first focusable) on open.
    const first = focusables()[0];
    const current = document.activeElement;
    if (first && (!(current instanceof HTMLElement) || !root.contains(current))) {
      first.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
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
      // Restore focus to wherever the user was before the overlay opened.
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [active]);

  return ref;
}
