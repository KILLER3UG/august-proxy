/* ── useSmoothReveal ─────────────────────────────────────────────────────
 * Decouples text ARRIVAL from text DISPLAY for the streaming answer.
 *
 * The backend coalesces provider deltas into ~64-char SSE events (and the
 * network coalesces further), so raw event-driven rendering paints whole
 * sentence chunks at once. This hook advances a revealed-prefix length on
 * requestAnimationFrame toward the full target with an adaptive rate:
 *   advance = clamp(ceil(backlog / 12), 1, 24) chars/frame
 * — a steady trickle reveals ~60–180 chars/s (a smooth typing feel), while
 * a big burst is chewed through fast and then eases out (the proportional
 * rate is a natural deceleration), fully converging well under a second.
 *
 * Rules:
 *  • Only the LIVE tail is animated. When `active` is false (settled block,
 *    copy, persistence) the full target is returned untouched.
 *  • If the target shrinks (retry rollback truncates the accumulator), the
 *    shown length clamps down immediately — no stale tail.
 *  • `prefers-reduced-motion` disables the animation entirely.
 */

import { useEffect, useRef, useState } from 'react';

const CATCHUP_FRAMES = 12; // spread a burst over ~200 ms at 60 fps
const MAX_CHARS_PER_FRAME = 24;

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

export function useSmoothReveal(target: string, active: boolean): string {
  const [revealed, setRevealed] = useState(target);
  const targetRef = useRef(target);
  targetRef.current = target;
  const shownRef = useRef(target.length);
  const emittedRef = useRef(target);

  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      shownRef.current = targetRef.current.length;
      emittedRef.current = targetRef.current;
      setRevealed(targetRef.current);
      return;
    }
    let raf = 0;
    const step = () => {
      const full = targetRef.current;
      let shown = shownRef.current;
      if (shown > full.length) shown = full.length; // rollback / shrink
      if (shown >= full.length) {
        if (emittedRef.current !== full) {
          emittedRef.current = full;
          setRevealed(full);
        }
        raf = requestAnimationFrame(step); // idle-poll for new arrivals
        return;
      }
      const backlog = full.length - shown;
      const advance = Math.min(
        MAX_CHARS_PER_FRAME,
        Math.max(1, Math.ceil(backlog / CATCHUP_FRAMES)),
      );
      shown = Math.min(full.length, shown + advance);
      shownRef.current = shown;
      const slice = full.slice(0, shown);
      emittedRef.current = slice;
      setRevealed(slice);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return active ? revealed : target;
}
