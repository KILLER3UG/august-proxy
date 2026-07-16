/**
 * Hover intent for composer side-flyouts (model effort / agent mode).
 * Opening the first flyout is slightly delayed; swapping between flyouts
 * is instant so Effort ↔ Models (etc.) does not exit/re-enter the shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 200;

export function useFlyoutHover<T extends string>() {
  const [flyout, setFlyout] = useState<T | null>(null);
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyoutRef = useRef<T | null>(null);
  flyoutRef.current = flyout;

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimer.current) {
      clearTimeout(hoverOpenTimer.current);
      hoverOpenTimer.current = null;
    }
  }, []);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);

  const clearAllTimers = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

  const scheduleFlyoutOpen = useCallback(
    (next: T) => {
      if (!next) return;
      clearHoverCloseTimer();
      if (flyoutRef.current === next) return;
      clearHoverOpenTimer();
      // Already showing a sibling flyout — swap immediately (no exit blink).
      if (flyoutRef.current !== null) {
        setFlyout(next);
        return;
      }
      hoverOpenTimer.current = setTimeout(() => setFlyout(next), HOVER_OPEN_MS);
    },
    [clearHoverCloseTimer, clearHoverOpenTimer],
  );

  const scheduleFlyoutClose = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    hoverCloseTimer.current = setTimeout(() => setFlyout(null), HOVER_CLOSE_MS);
  }, [clearHoverOpenTimer, clearHoverCloseTimer]);

  const keepFlyoutOpen = useCallback(() => {
    clearAllTimers();
  }, [clearAllTimers]);

  const toggleFlyout = useCallback(
    (next: T) => {
      clearAllTimers();
      setFlyout((f) => (f === next ? null : next));
    },
    [clearAllTimers],
  );

  const resetFlyout = useCallback(() => {
    clearAllTimers();
    setFlyout(null);
  }, [clearAllTimers]);

  useEffect(() => () => clearAllTimers(), [clearAllTimers]);

  return {
    flyout,
    setFlyout,
    scheduleFlyoutOpen,
    scheduleFlyoutClose,
    keepFlyoutOpen,
    toggleFlyout,
    resetFlyout,
    clearAllTimers,
  };
}
