/**
 * Keep the chat transcript pinned to the bottom while streaming —
 * unless the user scrolls up to read earlier content.
 *
 * Uses a rAF lerp instead of per-token scrollTop snaps so long replies
 * scroll down smoothly without feeling laggy. Instant snap on session load
 * / turn start stays in the caller.
 *
 * Upward wheel / touch / PageUp releases the pin and disables CSS
 * overflow-anchor so generation cannot yank the viewport back down.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const FREE_CLASS = 'chat-scroll--free';

export function useStickToBottomScroll({
  scrollRef,
  pinnedToBottomRef,
  streaming,
  sessionId,
  loadedSessionId,
  messagesVersion,
  onPinnedChange,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pinnedToBottomRef: MutableRefObject<boolean>;
  streaming: boolean;
  sessionId: string | null;
  loadedSessionId: string | null;
  /** Any value that changes when transcript content grows (e.g. messages). */
  messagesVersion: unknown;
  /** Fired when pin state changes (for jump-to-bottom chrome). */
  onPinnedChange?: (pinned: boolean) => void;
}) {
  /** True while we assign scrollTop — ignore those events for pin tracking. */
  const programmaticScrollRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const onPinnedChangeRef = useRef(onPinnedChange);
  onPinnedChangeRef.current = onPinnedChange;

  const getScrollTarget = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    // closest() returns Element; the scroll container is an HTMLElement and
    // callers rely on that (scrollTop/scrollTo). The assertion is required
    // for tsc even though eslint's type service calls it unnecessary.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return (el.closest('.overflow-y-auto') as HTMLElement | null) ?? el;
  }, [scrollRef]);

  const setPinned = useCallback(
    (pinned: boolean) => {
      if (pinnedToBottomRef.current === pinned) {
        const el = getScrollTarget();
        el?.classList.toggle(FREE_CLASS, !pinned);
        return;
      }
      pinnedToBottomRef.current = pinned;
      const el = getScrollTarget();
      el?.classList.toggle(FREE_CLASS, !pinned);
      onPinnedChangeRef.current?.(pinned);
    },
    [getScrollTarget, pinnedToBottomRef],
  );

  const applyScrollTop = useCallback((el: HTMLElement, next: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = next;
    // Clear on next frame so the browser's scroll event from this write is ignored.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  const scrollToBottomSmooth = useCallback(() => {
    const target = getScrollTarget();
    if (!target) return;
    setPinned(true);
    // Keep the programmatic guard up for the whole smooth animation so the
    // distance-from-bottom check doesn't briefly flip pinned=false mid-scroll.
    programmaticScrollRef.current = true;
    target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, prefersReducedMotion() ? 50 : 450);
  }, [getScrollTarget, setPinned]);

  const scrollToBottomImmediate = useCallback(() => {
    const target = getScrollTarget();
    if (!target) return;
    setPinned(true);
    // Snap now, then keep re-snapping for up to ~400ms while the page height
    // settles: virtualized rows re-measure as they enter the viewport and
    // late content (images, collapsibles) can grow the transcript after the
    // first snap. Without the settle pass the jump lands above the true
    // bottom ("stops midway"). The programmatic guard stays up for the whole
    // settle so pin tracking never sees these writes as user scrolls.
    programmaticScrollRef.current = true;
    target.scrollTop = target.scrollHeight;
    let lastHeight = target.scrollHeight;
    let stableFrames = 0;
    const deadline = performance.now() + 400;
    const settle = () => {
      const el = getScrollTarget();
      // User scrolled away mid-settle — stop fighting them.
      if (!el || !pinnedToBottomRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      el.scrollTop = el.scrollHeight;
      if (el.scrollHeight === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = el.scrollHeight;
      }
      if (stableFrames >= 2 || performance.now() >= deadline) {
        programmaticScrollRef.current = false;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [getScrollTarget, pinnedToBottomRef, setPinned]);

  // User intent to read earlier content: release pin immediately.
  useEffect(() => {
    const el = getScrollTarget();
    if (!el) return;

    const release = () => setPinned(false);

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };

    const onTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const start = touchStartYRef.current;
      const y = e.touches[0]?.clientY;
      if (start == null || y == null) return;
      // Finger moves down → content scrolls up.
      if (y - start > 8) release();
    };
    const onTouchEnd = () => {
      touchStartYRef.current = null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
        // Only release when the chat scroller (or a child) has focus / is target.
        if (el.contains(document.activeElement) || document.activeElement === el) {
          release();
        }
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [getScrollTarget, setPinned, sessionId, messagesVersion]);

  // Smooth follow while streaming + pinned. Adaptive lerp: small gaps ease,
  // large chunks catch up quickly so the viewport never falls behind tokens.
  useEffect(() => {
    if (!streaming) return;
    if (!sessionId || loadedSessionId !== sessionId) return;

    const reduced = prefersReducedMotion();
    let raf = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const el = getScrollTarget();
      if (el && pinnedToBottomRef.current) {
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        const gap = maxScroll - el.scrollTop;
        if (gap > 0.4) {
          if (reduced) {
            applyScrollTop(el, maxScroll);
          } else {
            const alpha = gap > 180 ? 0.75 : gap > 56 ? 0.5 : 0.34;
            applyScrollTop(
              el,
              el.scrollTop + Math.max(gap * alpha, Math.min(gap, 2.25)),
            );
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [
    streaming,
    sessionId,
    loadedSessionId,
    getScrollTarget,
    pinnedToBottomRef,
    applyScrollTop,
  ]);

  // When idle (or stream just ended), snap if anchoring slipped.
  useLayoutEffect(() => {
    if (!sessionId || loadedSessionId !== sessionId) return;
    if (!pinnedToBottomRef.current) return;
    if (streaming) return;
    const target = getScrollTarget();
    if (!target) return;
    const dist = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (dist > 4) {
      applyScrollTop(target, target.scrollHeight);
    }
  }, [
    sessionId,
    loadedSessionId,
    messagesVersion,
    streaming,
    getScrollTarget,
    pinnedToBottomRef,
    applyScrollTop,
  ]);

  return {
    getScrollTarget,
    scrollToBottomSmooth,
    scrollToBottomImmediate,
    programmaticScrollRef,
    setPinned,
  };
}
