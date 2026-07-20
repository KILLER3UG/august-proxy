/**
 * Thought step: clock at top, vertical stem under it, prose beside the stem.
 * When settled (last thought + final answer), stem ends in ✓ Done.
 */

import { useId } from 'react';
import { Check, ChevronDown, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';

function thoughtSummary(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return 'Thought';
  const cut = text.match(/^(.+?[.!?])(?:\s|$)/);
  const line = (cut?.[1] || text).trim();
  return line.length > 96 ? `${line.slice(0, 93).trimEnd()}…` : line;
}

export function ThoughtStep({
  content,
  isGenerating = false,
  expanded = true,
  showDone = false,
  onToggle,
  className,
}: {
  content: string;
  isGenerating?: boolean;
  expanded?: boolean;
  /** Last thought with a final answer after it — show ✓ Done under the stem. */
  showDone?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const reactId = useId();
  const panelId = `thought-step-panel-${reactId}`;
  const text = content.trim();
  if (!text && !isGenerating) return null;

  const summary = isGenerating
    ? text
      ? thoughtSummary(text)
      : 'Thinking…'
    : thoughtSummary(text);
  const canToggle = typeof onToggle === 'function';
  const done = showDone && !isGenerating;

  const clockIcon = isGenerating ? (
    <Loader2 className="process-thought-clock animate-spin" aria-hidden />
  ) : (
    <Clock className="process-thought-clock" aria-hidden />
  );

  // Collapsed: clock + one-line summary.
  if (!expanded) {
    return (
      <div
        className={cn(
          'process-step process-step--thought process-step--tool',
          className,
        )}
        data-slot="thought-step"
        data-generating={isGenerating ? 'true' : 'false'}
        data-expanded="false"
        data-done={done ? 'true' : 'false'}
      >
        {canToggle ? (
          <button
            type="button"
            className="process-tool-toggle process-thought-toggle"
            onClick={onToggle}
            aria-expanded={false}
            aria-controls={panelId}
          >
            <span className="process-step-gutter" aria-hidden>
              {clockIcon}
            </span>
            <span
              className={cn(
                'process-tool-label process-thought-label',
                isGenerating && 'process-thought-label--live',
              )}
            >
              {summary}
            </span>
            {done ? (
              <span className="process-thought-done" data-slot="thought-done">
                Done
              </span>
            ) : null}
            <ChevronDown className="process-tool-chevron" aria-hidden />
          </button>
        ) : (
          <div className="process-tool-toggle process-thought-toggle" aria-hidden>
            <span className="process-step-gutter">{clockIcon}</span>
            <span className="process-tool-label process-thought-label">
              {summary}
            </span>
            {done ? (
              <span className="process-thought-done" data-slot="thought-done">
                Done
              </span>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  // Expanded: clock → stem → (✓ Done); prose sits beside the stem.
  return (
    <div
      className={cn('process-thought', done && 'process-thought--done', className)}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
      data-expanded="true"
      data-done={done ? 'true' : 'false'}
    >
      <div className="process-thought-axis" aria-hidden={!canToggle}>
        {canToggle ? (
          <button
            type="button"
            className="process-thought-icon-btn"
            onClick={onToggle}
            aria-expanded
            aria-controls={panelId}
            aria-label="Collapse thought"
          >
            {clockIcon}
          </button>
        ) : (
          <span className="process-thought-icon-static">{clockIcon}</span>
        )}
        <div className="process-thought-stem" aria-hidden />
        {done ? (
          <Check className="process-thought-check" strokeWidth={2.25} />
        ) : null}
      </div>

      <div className="process-thought-body">
        <div
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
        {done ? (
          <div className="process-thought-done" data-slot="thought-done">
            Done
          </div>
        ) : null}
      </div>
    </div>
  );
}
