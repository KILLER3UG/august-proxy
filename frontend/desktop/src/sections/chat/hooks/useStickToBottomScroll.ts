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
import { useReducedMotion } from '@/lib/motion';
import { OVERSIZE_STREAMING_ROW_RATIO } from '@/lib/chat-scroll';

const FREE_CLASS = 'chat-scroll--free';
// A scroll event that moves the view UP by more than this is the reader leaving
// the bottom. Below it, sub-pixel rounding and fractional device-pixel ratios
// would release the pin on our own animation.
const SCROLL_RELEASE_PX = 2;


/** The live streaming message row (`.chat-streaming-block` inside the last
 *  message), measured against the viewport height. */
function streamingRowExceedsViewport(scrollEl: HTMLElement): boolean {
  const block = scrollEl.querySelector('.chat-streaming-block');
  const row = block?.closest('[data-artifact-source]') as HTMLElement | null;
  if (!row) return false;
  const viewport = scrollEl.clientHeight;
  if (viewport <= 0) return false;
  return row.offsetHeight > viewport * OVERSIZE_STREAMING_ROW_RATIO;
}

export function useStickToBottomScroll({
  scrollRef,
  pinnedToBottomRef,
  streaming,
  sessionId,
  loadedSessionId,
  messagesVersion,
  hasContent,
  onPinnedChange,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pinnedToBottomRef: MutableRefObject<boolean>;
  streaming: boolean;
  sessionId: string | null;
  loadedSessionId: string | null;
  /** Any value that changes when transcript content grows (e.g. messages). */
  messagesVersion: unknown;
  /** True once the transcript holds at least one message. The scroller
   *  element only exists after the empty state is replaced by the list, so
   *  the release listeners must rebind exactly on this 0 → >0 flip. */
  hasContent: boolean;
  /** Fired when pin state changes (for jump-to-bottom chrome). */
  onPinnedChange?: (pinned: boolean) => void;
}) {
  /** True while we assign scrollTop — ignore those events for pin tracking. */
  const programmaticScrollRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  // Last scrollTop we saw, so a scroll event can be judged by DIRECTION rather
  // than by which input device produced it.
  const lastScrollTopRef = useRef(0);
  // The position our own last write asked for. Anything ABOVE that did not come
  // from us — which the programmatic guard alone cannot tell you, because the
  // follow animation raises it on every frame, i.e. precisely while a reader is
  // trying to escape the bottom.
  const lastAppliedTopRef = useRef(-1);
  const onPinnedChangeRef = useRef(onPinnedChange);
  onPinnedChangeRef.current = onPinnedChange;
  // Audit P2#18 — the sanctioned reduced-motion read (lib/motion.ts). The
  // two former `prefersReducedMotion()` calls were re-read at scroll time;
  // the hook reads once per mount, which is the same value for the life of
  // a streaming turn.
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

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
    // Record what the browser ACTUALLY landed on, not what was asked for.
    // `next` is routinely clamped (already at the bottom, sub-pixel rounding,
    // a scrollbar appearing between measure and write), and anchoring on the
    // requested value makes the next scroll event look like the reader moved
    // up — the pin then releases on our own write.
    lastAppliedTopRef.current = el.scrollTop;
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
    }, reducedMotionRef.current ? 50 : 450);
  }, [getScrollTarget, setPinned]);

  const scrollToBottomImmediate = useCallback(() => {
    const target = getScrollTarget();
    if (!target) return;
    setPinned(true);
    // Snap now, then keep re-snapping while the page height settles:
    // virtualized rows re-measure as they enter the viewport and late
    // content (images, collapsibles) can grow the transcript after the
    // first snap. Without the settle pass the jump lands above the true
    // bottom ("stops midway"). The programmatic guard stays up for the
    // whole settle so pin tracking never sees these writes as user scrolls.
    //
    // The measurement cascade arrives in waves with quiet gaps between them
    // (heavy markdown / code highlighting can stall a frame or several), so
    // the loop only gives up after ~8 consecutive unchanged frames, and runs
    // up to 1.5s overall. A tighter tolerance exited mid-cascade on long
    // transcripts and left session switches stranded near the top.
    programmaticScrollRef.current = true;
    target.scrollTop = target.scrollHeight;
    let lastHeight = target.scrollHeight;
    let stableFrames = 0;
    const deadline = performance.now() + 1500;
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
      if (stableFrames >= 8 || performance.now() >= deadline) {
        programmaticScrollRef.current = false;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [getScrollTarget, pinnedToBottomRef, setPinned]);

  // User intent to read earlier content: release pin immediately. The
  // listener only needs to rebind when the scroll element changes (sessionId
  // or a session load) or when content first appears (hasContent 0 → >0:
  // the empty-state div is replaced by the populated list — a new scroll
  // target with no listeners yet). Binding on every content change used to
  // thrash the listener on every stream flush.
  useEffect(() => {
    // Bound on `document` in the capture phase and resolved per event, NOT on
    // the element that happened to exist when this effect ran. The transcript
    // node is replaced on a session switch and on the empty→populated swap; a
    // listener left on the detached node never fires again, and the pin then
    // only moves on wheel — which is what the app showed and jsdom never did.
    const release = () => setPinned(false);

    const fromOurScroller = (target: EventTarget | null) => {
      const scroller = getScrollTarget();
      return !!scroller && target === scroller;
    };

    const onWheel = (e: WheelEvent) => {
      if (!fromOurScroller(e.target)) return;
      if (e.deltaY < 0) release();
    };

    // Wheel and touch only cover two of the ways a reader moves the view.
    // Dragging the scrollbar, a trackpad two-finger gesture that arrives as a
    // scroll without a wheel event, a focus jump from inside the transcript and
    // `scrollIntoView` from a tool card all change scrollTop while emitting no
    // wheel/touch/keydown at all — so the pin never released and the streaming
    // lerp kept pulling the reader back to the bottom. Judging the DIRECTION of
    // scrollTop catches all of them. Our own writes are excluded by the
    // programmatic guard, which is held up for the whole animation.
    const onScroll = (e: Event) => {
      if (!fromOurScroller(e.target)) return;
      const el = getScrollTarget();
      if (!el) return;
      const top = el.scrollTop;
      const delta = top - lastScrollTopRef.current;
      lastScrollTopRef.current = top;
      if (
        pinnedToBottomRef.current
        && lastAppliedTopRef.current >= 0
        && top < lastAppliedTopRef.current - SCROLL_RELEASE_PX
      ) {
        // Above where our own last write put it. Only a reader can do that, and
        // this holds even while the follow animation has the guard raised —
        // which is every frame of a stream, i.e. exactly when it matters.
        release();
        return;
      }
      // Nothing has been written yet, so there is no anchor to compare against
      // and direction is all there is — but only for events that are
      // demonstrably not ours.
      if (programmaticScrollRef.current) return;
      if (delta < -SCROLL_RELEASE_PX && pinnedToBottomRef.current) release();
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!fromOurScroller(e.target)) return;
      touchStartYRef.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!fromOurScroller(e.target)) return;
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
        const el = getScrollTarget();
        if (el && (el.contains(document.activeElement) || document.activeElement === el)) {
          release();
        }
      }
    };

    const initial = getScrollTarget();
    if (initial) lastScrollTopRef.current = initial.scrollTop;
    // Capture phase on the document: `scroll` does not bubble, but the capture
    // pass still reaches document before the target, so one permanent listener
    // sees every scroller swap.
    document.addEventListener('wheel', onWheel, { passive: true, capture: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPinned, sessionId, loadedSessionId, hasContent]);

  // Smooth follow while streaming + pinned. Adaptive lerp: small gaps ease,
  // large chunks catch up quickly so the viewport never falls behind tokens.
  useEffect(() => {
    if (!streaming) return;
    if (!sessionId || loadedSessionId !== sessionId) return;

    const reduced = reducedMotion;
    let raf = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const el = getScrollTarget();
      // A streaming message taller than the viewport has no stable anchor:
      // following its bottom drags the content ABOVE the user away instead of
      // revealing new text (audit P1). Hold position and let the "New content"
      // pill do its job — the user can still jump to the live tail.
      if (el && pinnedToBottomRef.current && streamingRowExceedsViewport(el)) {
        setPinned(false);
        raf = requestAnimationFrame(tick);
        return;
      }
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
    reducedMotion,
    setPinned,
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
