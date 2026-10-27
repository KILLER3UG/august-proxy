/* ── useMediaQuery — a media query as reactive state ────────────────── */
/* The shell's own width is measured by `useShellWidth` (a ResizeObserver on
 * the shell element), and that is what layout decisions should use. This hook
 * exists for the decisions that are not layout: the phone tier renders a
 * DIFFERENT tree (topbar + tabbar instead of the desktop titlebar/sidebar,
 * a settings list instead of the rail), and a rendered-tree switch has to
 * happen in React, not in CSS.
 *
 * Kept in step with the `@container august-shell (max-width: 760px)` block in
 * chat.css: both describe the same breakpoint, so MOBILE_QUERY is the one
 * place the number lives for JS. */

import { useEffect, useState } from 'react';

/** The phone tier. The packaged desktop window cannot reach it (minWidth 960);
 *  this is the mobile companion's WebView, which loads the same SPA. */
export const MOBILE_QUERY = '(max-width: 760px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}
