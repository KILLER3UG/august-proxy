// useResizablePane — the one drag/keyboard resize implementation for the
// shell's three panes (session sidebar, right drawer, bottom terminal dock).
//
// Before this, each pane hand-rolled the same mouse/touch drag plus its own
// cleanup listeners, and only the drawer was keyboard-operable — a keyboard
// user could not resize the sidebar at all. One hook means one contract:
//   • pointer drag with window-level move/up listeners (so a fast drag that
//     leaves the 1px handle still tracks)
//   • touch drag
//   • keyboard: arrows (Shift = coarse), Home = min, End = max
//   • re-clamp when the window resizes (the sidebar used to overflow after
//     the window shrank; the drawer clamped)
//   • optional persistence

import { useCallback, useEffect, useRef, useState } from 'react';

export type ResizeAxis = 'x' | 'y';

export interface UseResizablePaneOptions {
  /** px on first paint when nothing is stored */
  initial: number;
  min: number;
  /** Max px, or a function (e.g. viewport fraction, which changes). */
  max: number | (() => number);
  axis: ResizeAxis;
  /** +1 when increasing the axis coordinate grows the pane (sidebar: +1,
   *  bottom dock: -1 because it grows upward). Defaults to +1. */
  direction?: 1 | -1;
  /** localStorage key; omit to skip persistence. */
  storageKey?: string;
  /** Fine step for arrow keys. */
  step?: number;
  /** Coarse step (Shift+arrow). */
  stepLarge?: number;
}

export interface UseResizablePaneResult {
  size: number;
  setSize: (value: number) => void;
  isDragging: boolean;
  /** Spread onto the separator element. */
  handleProps: {
    role: 'separator';
    tabIndex: number;
    'aria-orientation': 'vertical' | 'horizontal';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    'aria-label': string;
    onMouseDown: (e: React.MouseEvent) => void;
    onTouchStart: (e: React.TouchEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

export function useResizablePane(
  opts: UseResizablePaneOptions & { 'aria-label': string },
): UseResizablePaneResult {
  const { initial, min, max, axis, direction = 1, storageKey, step = 16, stepLarge = 48 } = opts;
  const label = opts['aria-label'];

  const maxOf = useCallback(() => (typeof max === 'function' ? max() : max), [max]);
  const clamp = useCallback(
    (value: number) => Math.min(maxOf(), Math.max(min, Math.round(value))),
    [maxOf, min],
  );

  const [size, setSizeState] = useState<number>(() => {
    if (typeof window === 'undefined') return initial;
    if (!storageKey) return clamp(initial);
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return clamp(Number.isFinite(parsed) ? parsed : initial);
  });
  const [isDragging, setIsDragging] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const setSize = useCallback(
    (value: number) => setSizeState(clamp(value)),
    [clamp],
  );

  // Persist.
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, String(size));
  }, [size, storageKey]);

  // Re-clamp when the ceiling moves (window resize) — every pane gets this now.
  useEffect(() => {
    setSizeState((prev) => clamp(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxOf, clamp]);

  // Abort a drag if the component unmounts mid-drag.
  useEffect(() => {
    if (!isDragging) return;
    const stop = () => setIsDragging(false);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    window.addEventListener('touchcancel', stop);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchend', stop);
      window.removeEventListener('touchcancel', stop);
    };
  }, [isDragging]);

  const coord = (e: MouseEvent | TouchEvent) => {
    if ('touches' in e && e.touches.length) return e.touches[0][axis === 'x' ? 'clientX' : 'clientY'];
    const me = e as MouseEvent;
    return axis === 'x' ? me.clientX : me.clientY;
  };

  const startResize = (startCoord: number) => {
    const startSize = sizeRef.current;
    setIsDragging(true);
    const onMove = (ev: MouseEvent | TouchEvent) => {
      const delta = coord(ev) - startCoord;
      setSizeState(clamp(startSize + delta * direction));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove as (e: MouseEvent) => void);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove as (e: TouchEvent) => void);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove as (e: MouseEvent) => void);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove as (e: TouchEvent) => void, { passive: true });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
  };

  const handleProps = {
    role: 'separator' as const,
    tabIndex: 0,
    'aria-orientation': axis === 'x' ? ('vertical' as const) : ('horizontal' as const),
    'aria-valuenow': Math.round(size),
    'aria-valuemin': min,
    'aria-valuemax': Math.round(maxOf()),
    'aria-label': label,
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      startResize(axis === 'x' ? e.clientX : e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length) startResize(axis === 'x' ? e.touches[0].clientX : e.touches[0].clientY);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      const growKey = axis === 'x' ? 'ArrowRight' : 'ArrowUp';
      const shrinkKey = axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
      const delta = e.shiftKey ? stepLarge : step;
      if (e.key === growKey) {
        e.preventDefault();
        setSize(size + delta * direction);
      } else if (e.key === shrinkKey) {
        e.preventDefault();
        setSize(size - delta * direction);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSize(min);
      } else if (e.key === 'End') {
        e.preventDefault();
        setSize(maxOf());
      }
    },
  };

  return { size, setSize, isDragging, handleProps };
}