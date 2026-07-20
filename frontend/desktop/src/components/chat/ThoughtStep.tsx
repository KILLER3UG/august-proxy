/**
 * Thought step: icon gutter + muted rail prose (Claude-style left line).
 * Expanded by default; can collapse to a one-line summary.
 */

import { useId } from 'react';
import { ChevronDown, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';

function thoughtSummary(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return 'Thought';
  // Prefer first sentence-ish chunk as the collapsed label.
  const cut = text.match(/^(.+?[.!?])(?:\s|$)/);
  const line = (cut?.[1] || text).trim();
  return line.length > 96 ? `${line.slice(0, 93).trimEnd()}…` : line;
}

export function ThoughtStep({
  content,
  isGenerating = false,
  expanded = true,
  onToggle,
  className,
}: {
  content: string;
  isGenerating?: boolean;
  expanded?: boolean;
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

  const gutterIcon = isGenerating ? (
    <Loader2 className="process-step-icon animate-spin" />
  ) : (
    <Clock className="process-step-icon" />
  );

  // Collapsed: one-line summary.
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
              {gutterIcon}
            </span>
            <span
              className={cn(
                'process-tool-label process-thought-label',
                isGenerating && 'process-thought-label--live',
              )}
            >
              {summary}
            </span>
            <ChevronDown className="process-tool-chevron" aria-hidden />
          </button>
        ) : (
          <div className="process-tool-toggle process-thought-toggle" aria-hidden>
            <span className="process-step-gutter">{gutterIcon}</span>
            <span className="process-tool-label process-thought-label">
              {summary}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Expanded: icon gutter + left-rail prose (reference look).
  return (
    <div
      className={cn('process-step process-step--thought', className)}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
      data-expanded="true"
    >
      <span className="process-step-gutter" aria-hidden={!canToggle}>
        {canToggle ? (
          <button
            type="button"
            className="process-thought-icon-btn"
            onClick={onToggle}
            aria-expanded
            aria-controls={panelId}
            aria-label="Collapse thought"
          >
            {gutterIcon}
          </button>
        ) : (
          gutterIcon
        )}
      </span>
      <div
        id={panelId}
        className="process-step-body"
        aria-live={isGenerating ? 'polite' : undefined}
      >
        {text ? (
          <div className="process-thought-rail thought-content chat-thought-text">
            <Markdown content={text} />
          </div>
        ) : (
          <div className="process-thought-rail process-thought-pending">
            Thinking…
          </div>
        )}
      </div>
    </div>
  );
}
