/* MarqueeTitle — scrolls long titles on hover when they overflow. */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface MarqueeTitleProps {
  text: string;
  className?: string;
  /** Extra class on the inner scrolling span */
  innerClassName?: string;
  title?: string;
  'data-testid'?: string;
  /** An overflowing title scrolls on hover instead of ellipsising. */
  scrollOnHover?: boolean;
}

/**
 * Renders `text` truncated when it fits. When the text overflows, hovering
 * the title starts a smooth marquee so the full string is readable.
 */
export function MarqueeTitle({
  text,
  className,
  innerClassName,
  title,
  /** Ellipsise (default) or scroll on hover. The sidebar ellipsises to match
   *  the reference; the titlebar scrolls, where a long title is worth it. */
  scrollOnHover = false,
  'data-testid': testId,
}: MarqueeTitleProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      // scrollWidth can exceed clientWidth when text is long
      setOverflow(inner.scrollWidth > outer.clientWidth + 1);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(outer);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [text]);

  /* Truncate with an ELLIPSIS, not a scroll animation.
   *
   * The reference sidebar clips titles with `text-overflow: ellipsis` at the
   * rail edge and no fade. The marquee (`overflow-hidden` +
   * `whitespace-nowrap` + a keyframe scroll) instead hard-clipped mid-glyph —
   * measured `titleW 188 / scrollW 255` at a 900px viewport, which rendered as
   * "Friendly greeting to start conve" with the last character sliced. That
   * reads as a rendering bug, not as truncation.
   *
   * `overflow && scrollOnHover` keeps the marquee available for callers that
   * genuinely want it (the titlebar, where a long session title is worth
   * scrolling); the sidebar passes `scrollOnHover={false}` so it ellipsises. */
  const marquee = overflow && scrollOnHover;

  return (
    <div
      ref={outerRef}
      className={cn('group/marquee min-w-0 overflow-hidden', className)}
      title={title ?? text}
      data-testid={testId}
      data-overflow={overflow ? 'true' : 'false'}
    >
      <span
        ref={innerRef}
        className={cn(
          'inline-block whitespace-nowrap',
          /* `max-w-none` had to go: it overrode the shrink the ellipsis needs,
             so the span stayed as wide as its text and `text-overflow` had
             nothing to truncate against — the row hard-clipped mid-glyph
             instead. `w-full` + `min-w-0` on the parent gives it a bound. */
          marquee ? 'max-w-none marquee-title-scroll' : 'w-full truncate',
          innerClassName,
        )}
      >
        {text}
      </span>
    </div>
  );
}
