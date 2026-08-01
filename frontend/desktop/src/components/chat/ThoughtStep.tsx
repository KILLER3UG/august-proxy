/**
 * Thought step — the model's reasoning rendered as prose on the process rail.
 *
 * Layout: a clock icon on the threaded rail line, with the reasoning prose
 * beside it. Long settled thoughts are clamped to a fixed number of lines
 * with a bottom fade and a "Show more" affordance (the screenshot's look);
 * "Show less" restores the clamp. While the thought is still streaming it
 * grows unclamped so the live text is never hidden.
 *
 * The clock is a static marker (the whole rail collapses via ActivitySummary
 * for compactness); expand/collapse of the prose is driven solely by the
 * Show more/less control. The turn-level "Done" marker lives on the rail
 * (RailDoneRow), not on the thought.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';

/** Lines of prose visible before the clamp + fade kick in. */
const CLAMP_LINES = 9;

export function ThoughtStep({
  content,
  isGenerating = false,
  showFull = false,
  onToggle,
  className,
}: {
  content: string;
  isGenerating?: boolean;
  /** Prose shown in full (unclamped). Parent seeds this: true while the turn
   *  is streaming, false once settled (→ clamped if it overflows). */
  showFull?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const reactId = useId();
  const panelId = `thought-step-panel-${reactId}`;
  const text = content.trim();
  const proseRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Measure the natural prose height against the clamp. The inner prose is
  // never the clip container, so its scrollHeight is the full height whether
  // or not the wrapper is clamped — measuring it directly tracks root-font
  // scaling (line-height is resolved in px by the browser).
  useLayoutEffect(() => {
    const el = proseRef.current;
    if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      setOverflowing(el.scrollHeight > lh * CLAMP_LINES + 4);
    };
    measure();
    // ResizeObserver is absent in some test runtimes (jsdom); a single
    // measure is enough there since the prose never reflows.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, showFull]);

  if (!text && !isGenerating) return null;

  // Never clamp a live thought — let streaming reasoning grow freely.
  const clamped = overflowing && !showFull && !isGenerating;
  const canReveal = overflowing && !isGenerating && typeof onToggle === 'function';

  const clockIcon = isGenerating ? (
    <Loader2 className="process-thought-clock animate-spin" aria-hidden />
  ) : (
    <Clock className="process-thought-clock" aria-hidden />
  );

  return (
    <div
      className={cn('rail-row process-thought', className)}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
      data-expanded={clamped ? 'false' : 'true'}
      data-clamped={clamped ? 'true' : 'false'}
    >
      <span className="rail-line" aria-hidden />
      <div className="process-thought-axis" aria-hidden>
        <span className="rail-icon">{clockIcon}</span>
      </div>

      <div className="process-thought-body">
        <div className={cn('thought-clamp', clamped && 'is-clamped')}>
          <div
            ref={proseRef}
            id={panelId}
            className="process-thought-prose thought-content chat-thought-text"
            aria-live={isGenerating ? 'polite' : undefined}
          >
            {text ? (
              <Markdown content={text} />
            ) : (
              <div className="process-thought-pending">Thinking…</div>
            )}
          </div>
          {clamped ? <div className="thought-fade" aria-hidden /> : null}
        </div>

        {canReveal ? (
          <button
            type="button"
            className="thought-toggle-btn"
            onClick={onToggle}
            aria-expanded={showFull}
            aria-controls={panelId}
          >
            <span>{showFull ? 'Show less' : 'Show more'}</span>
            <ChevronDown
              className={cn('thought-toggle-chevron', showFull && 'is-open')}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
