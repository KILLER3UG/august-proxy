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
          'inline-block whitespace-nowrap max-w-none',
          overflow && 'marquee-title-scroll',
          innerClassName,
        )}
      >
        {text}
      </span>
    </div>
  );
}
