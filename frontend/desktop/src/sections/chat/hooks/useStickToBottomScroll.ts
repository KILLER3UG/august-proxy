/**
 * Keep the chat transcript pinned to the bottom while streaming.
 *
 * Uses a rAF lerp instead of per-token scrollTop snaps so long replies
 * scroll down smoothly without feeling laggy. Instant snap on session load
 * / turn start stays in the caller.
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

export function useStickToBottomScroll({
  scrollRef,
  pinnedToBottomRef,
  streaming,
  sessionId,
  loadedSessionId,
  messagesVersion,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pinnedToBottomRef: MutableRefObject<boolean>;
  streaming: boolean;
  sessionId: string | null;
  loadedSessionId: string | null;
  /** Any value that changes when transcript content grows (e.g. messages). */
  messagesVersion: unknown;
}) {
  /** True while we assign scrollTop — ignore those events for pin tracking. */
  const programmaticScrollRef = useRef(false);

  const getScrollTarget = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    return (el.closest('.overflow-y-auto') as HTMLElement | null) ?? el;
  }, [scrollRef]);

  const applyScrollTop = useCallback((el: HTMLElement, next: number) => {
    programmaticScrollRef.current = true;
    el.scrollTop = next;
    programmaticScrollRef.current = false;
  }, []);

  const scrollToBottomSmooth = useCallback(() => {
    const target = getScrollTarget();
    if (!target) return;
    pinnedToBottomRef.current = true;
    target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
  }, [getScrollTarget, pinnedToBottomRef]);

  const scrollToBottomImmediate = useCallback(() => {
    const target = getScrollTarget();
    if (!target) return;
    applyScrollTop(target, target.scrollHeight);
  }, [getScrollTarget, applyScrollTop]);

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
  };
}
