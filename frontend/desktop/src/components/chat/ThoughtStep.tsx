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
 *
 * Claude-parity rendering (2026-09-22, revised 2026-10-22, summary-only
 * 2026-10-23, full-reasoning reveal 2026-10-27): with the collapsed default on
 * (the out-of-box behaviour), a thought renders as the reference's card BODY —
 * one distilled sentence per line, no header, no reveal. The card's TITLE
 * ("Thought for 49s") belongs to the activity line above the pack, which
 * already carries the elapsed time; a per-thought header repeated that run
 * duration on every block. The reference stops at that summary; August does
 * not — "Show full reasoning" swaps the summary for the model's own prose,
 * which is the whole point of keeping the raw text in the transcript at all.
 * The operator can still opt out of summary rendering entirely
 * (august.collapseThinking = '0'), which shows the prose clamped with a
 * "Show more" that unclamps it.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  distillThoughtLines,
  summarizeThoughtHeader,
} from '@/lib/process-summary';
import {
  THOUGHT_CLAMP_LINES,
  THOUGHT_CLAMP_CHARS,
  THOUGHT_SUMMARY_LINES,
  THOUGHT_SUMMARY_LINES_FULL,
} from '@/lib/thought-presentation';
import { Markdown } from '@/sections/chat/ChatMarkdown';

// Clamp constants live in lib/thought-presentation.ts — one owner shared
// with the plain (subagent) disclosure variant.

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
  // Whether this row is showing the model's own prose instead of its distilled
  // summary. Declared with the other hooks: the render below has an early
  // return, and a hook after it changes the hook order between renders.
  const [revealRaw, setRevealRaw] = useState(false);

  // Measure the natural prose height against the clamp. The inner prose is
  // never the clip container, so its scrollHeight is the full height whether
  // or not the wrapper is clamped — measuring it directly tracks root-font
  // scaling (line-height is resolved in px by the browser).
  useLayoutEffect(() => {
    const el = proseRef.current;
    if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      setOverflowing(el.scrollHeight > lh * THOUGHT_CLAMP_LINES + 4);
    };
    measure();
    // ResizeObserver is absent in some test runtimes (jsdom); a single
    // measure is enough there since the prose never reflows.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, showFull]);

  // Distilled step header (participle form: "Loading the skill…",
  // "Comparing benchmark results…"). While generating, distill the LATEST
  // sentence so the header rotates with the model's progress; once settled
  // it rests on the first informative sentence of the whole thought.
  // (Lives above the `!text && !isGenerating` early return — rules-of-hooks.)
  const summaryLine = useMemo(() => {
    if (isGenerating) {
      const sentences = text
        .replace(/```[\s\S]*?```/g, ' ')
        .split(/(?<=[.!?]["')\]]?)\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const tail = sentences[sentences.length - 1] ?? '';
      return summarizeThoughtHeader(tail, true);
    }
    return summarizeThoughtHeader(text, false);
  }, [text, isGenerating]);

  // The reference's thinking card is a LIST of the model's distilled
  // sentences - "Fixing a schematic diagram for a 3-to-8 decoder." /
  // "Designing the gate layout and wiring for the corrected circuit." - one
  // per line. The FULL list is computed once; the visible slice depends on
  // expansion (collapsed cap, or the raised expanded cap). Expansion never
  // reveals raw reasoning — the reference's opened card carries more of the
  // summary, and so does this one.
  //
  // A LIVE thought has no settled sentence list yet, so it keeps the one
  // rotating line until it settles.
  const distilledLines = useMemo(() => {
    if (isGenerating) return summaryLine ? [summaryLine] : [];
    return distillThoughtLines(text);
  }, [text, isGenerating, summaryLine]);

  const summaryCap = showFull ? THOUGHT_SUMMARY_LINES_FULL : THOUGHT_SUMMARY_LINES;
  const summaryLines = distilledLines.slice(0, summaryCap);
  const hiddenSummaryCount = Math.max(0, distilledLines.length - summaryCap);

  if (!text && !isGenerating) return null;

  // Clamp long thoughts whether streaming or settled: once the reasoning passes
  // the clamp height it is bounded with a fade + Show more, and the live tail
  // simply streams below the fold (matching the reference, where a mid-stream
  // thought is already truncated). Only an explicit Show more unclamps it.
  // `longThought` falls back to a length check when the pixel measurement is
  // unavailable or stale — a long thought must never render untruncated.
  const longThought = overflowing || text.length > THOUGHT_CLAMP_CHARS;
  const clamped = longThought && !showFull;

  // Claude-style think row: when the collapsed default is on, a thought
  // renders as its distilled "what the model is doing" sentences, and the one
  // control beneath it — "Show full reasoning" — swaps in the raw chain of
  // thought itself. The reveal is local to this row: the parent's `showFull`
  // still owns the streaming/expansion seed, and reading the whole reasoning
  // is not a decision the transcript should remember across reloads.
  const summaryCollapsed = collapsedDefault && !revealRaw;
  // A summary row is expandable whenever there IS a full reasoning behind it;
  // in the operator's opt-out layout the control only exists when the parent
  // wired a toggle to unclamp the prose.
  const canReveal = collapsedDefault
    ? !isGenerating && !!text
    : !!text && typeof onToggle === 'function';

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
      data-expanded={showFull ? 'true' : 'false'}
      data-clamped={clamped ? 'true' : 'false'}
    >
      <span className="rail-line" aria-hidden />
      <div className="process-thought-axis" aria-hidden>
        <span className="rail-icon">{clockIcon}</span>
      </div>

      <div className="process-thought-body">
        {/* No per-thought header. The reference names the THINKING CARD
            "Thought for 49s" once — here that title is the activity line's
            job (it already carries the elapsed time while the turn is live),
            and repeating the run's duration on every thought block is how
            three blocks each claimed "Thought for 6s". */}
        {summaryCollapsed ? (
          <div
            id={panelId}
            className={cn(
              'thought-summary',
              isGenerating && 'thought-summary--live',
              showFull && 'thought-summary--expanded',
            )}
            data-slot="thought-summary"
          >
            {/* One sentence per line, the way the reference's thinking
                card reads. The FIRST line is the header; the rest are the
                card's body. Expansion shows more of the SAME list, never
                the raw reasoning. */}
            <span className="thought-summary-text">
              {summaryLines.map((line, i) => (
                <span
                  key={i}
                  className={cn(
                    'thought-summary-line block',
                    i === 0 && 'thought-summary-line--first',
                  )}
                >
                  {line}
                </span>
              ))}
              {hiddenSummaryCount > 0 ? (
                <span className="thought-summary-line block text-muted-foreground/50">
                  …and {hiddenSummaryCount} more steps.
                </span>
              ) : null}
              {/* A settled thought whose every sentence the distiller
                  filtered (pure netlist/code noise) still owes the card a
                  body — an empty summary div reads as a rendering bug. */}
              {summaryLines.length === 0 && !isGenerating ? (
                <span className="thought-summary-line block">
                  {summarizeThoughtHeader('', false)}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <div className={cn('thought-clamp', clamped && 'is-clamped')}>
            <div
              ref={proseRef}
              id={panelId}
              className={cn(
                'process-thought-prose thought-content chat-thought-text',
                // The same one-shot fade the answer's live tail
                // uses, so streamed reasoning inks in instead of hard-popping.
                isGenerating && 'md-live-tail',
              )}
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
        )}

        {canReveal ? (
          <button
            type="button"
            className={cn('thought-toggle-btn', isGenerating && 'is-live')}
            onClick={collapsedDefault ? () => setRevealRaw((v) => !v) : onToggle}
            aria-expanded={collapsedDefault ? revealRaw : showFull}
            aria-controls={panelId}
          >
            <span>
              {collapsedDefault
                ? revealRaw ? 'Show less' : 'Show full reasoning'
                : showFull ? 'Show less' : 'Show more'}
            </span>
            <ChevronDown
              className={cn(
                'thought-toggle-chevron',
                (collapsedDefault ? revealRaw : showFull) && 'is-open',
              )}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
