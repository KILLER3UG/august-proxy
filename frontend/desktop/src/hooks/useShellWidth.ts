// useShellWidth — the shell's own width, so responsive behavior is bound to
// the app shell container rather than the viewport.
//
// Why not media queries: the right drawer closes independently of window
// width (a drawer-scoped layout should not care that the OS window is wide),
// and the whole app runs in a Tauri webview whose "viewport" is whatever the
// window happens to be — the old single @media (max-width: 900px) could never
// even fire in the packaged app (min window 960).

import { useEffect, useRef, useState } from 'react';

export interface ShellWidth<T extends HTMLElement = HTMLDivElement> {
  /** Attach to the shell container element. */
  ref: React.RefObject<T | null>;
  /** current width in px (0 before first measure) */
  width: number;
  /** < 1100px — the right drawer becomes a scrim overlay */
  drawerOverlays: boolean;
  /** < 760px — the sidebar becomes a scrim overlay too */
  sidebarOverlays: boolean;
}

const DRAWER_OVERLAY_MAX = 1100;
const SIDEBAR_OVERLAY_MAX = 760;

export function useShellWidth<T extends HTMLElement = HTMLDivElement>(): ShellWidth<T> {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return {
    ref,
    width,
    drawerOverlays: width > 0 && width < DRAWER_OVERLAY_MAX,
    sidebarOverlays: width > 0 && width < SIDEBAR_OVERLAY_MAX,
  };
}