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

/** Rough char equivalent of CLAMP_LINES (~80 chars/line) — the overflow
 *  measurement can read 0/stale when a whole-turn burst arrives at once, so
 *  a long thought must also truncate by length alone. */
const CLAMP_CHARS = 700;

export function ThoughtStep({
  content,
  isGenerating = false,
  showFull = false,
  onToggle,
  collapsedDefault = false,
  className,
}: {
  content: string;
  isGenerating?: boolean;
  /** Prose shown in full (unclamped). Parent seeds this: true while the turn
   *  is streaming, false once settled (→ clamped if it overflows). */
  showFull?: boolean;
  onToggle?: () => void;
  /** Collapse settled thoughts to a one-line summary (dsh-style think row).
   *  Only applies while clamped and not generating; "Show full reasoning"
   *  expands, "Show less" returns to the summary. */
  collapsedDefault?: boolean;
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

  // Clamp long thoughts whether streaming or settled: once the reasoning passes
  // the clamp height it is bounded with a fade + Show more, and the live tail
  // simply streams below the fold (matching the reference, where a mid-stream
  // thought is already truncated). Only an explicit Show more unclamps it.
  // `longThought` falls back to a length check when the pixel measurement is
  // unavailable or stale — a long thought must never render untruncated.
  const longThought = overflowing || text.length > CLAMP_CHARS;
  const clamped = longThought && !showFull;

  // dsh-style think row: while the thought is generating — or settled and
  // clamped — collapse to a one-line summary. While running the line follows
  // the latest non-blank line (fast tokens move fast); once settled it rests
  // on the first line. "Show full reasoning" expands mid-stream (even for
  // short live thoughts).
  const summaryCollapsed = collapsedDefault && !showFull && (isGenerating || clamped);
  const canReveal = (longThought || isGenerating) && typeof onToggle === 'function';

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const summaryLine = isGenerating
    ? lines[lines.length - 1] ?? ''
    : lines[0] ?? '';

  const clockIcon = isGenerating ? (
    <Loader2 className="process-thought-clock animate-spin" aria-hidden />
  ) : (
    <Clock className="process-thought-clock" aria-hidden />
  );

  return (
    <div
      className={cn('rail-row process-thought thought-enter', className)}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
      data-expanded={summaryCollapsed ? 'false' : showFull ? 'true' : 'false'}
      data-clamped={clamped ? 'true' : 'false'}
    >
      <span className="rail-line" aria-hidden />
      <div className="process-thought-axis" aria-hidden>
        <span className="rail-icon">{clockIcon}</span>
      </div>

      <div className="process-thought-body">
        {summaryCollapsed ? (
          <>
            <div
              className={cn(
                'thought-summary',
                isGenerating && 'thought-summary--live',
              )}
              data-slot="thought-summary"
            >
              <span className="thought-summary-text">{summaryLine}</span>
              {canReveal ? (
                <button
                  type="button"
                  className="thought-summary-toggle"
                  onClick={onToggle}
                  aria-expanded={false}
                >
                  Show full reasoning
                </button>
              ) : null}
            </div>
            {/* Keep the prose mounted (visually hidden) so the overflow
                measurement above stays accurate while collapsed. */}
            <div className="thought-clamp thought-clamp-hide" aria-hidden>
              <div
                ref={proseRef}
                className="process-thought-prose thought-content chat-thought-text"
              >
                <Markdown content={text} />
              </div>
            </div>
          </>
        ) : (
          <>
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
                className={cn('thought-toggle-btn', isGenerating && 'is-live')}
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
          </>
        )}
      </div>
    </div>
  );
}
