/**
 * Collapsible thought step: summary row; expand for rail prose.
 * Generating → summary only.
 * Done → check + one-line summary + "Done".
 */

import { useId } from 'react';
import { Check, ChevronDown } from 'lucide-react';
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
  expanded = false,
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

  return (
    <div
      className={cn(
        'process-step process-step--thought process-step--tool',
        className,
      )}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {canToggle ? (
        <button
          type="button"
          className="process-tool-toggle process-thought-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
        >
          <span className="process-step-gutter" aria-hidden>
            {!isGenerating ? (
              <Check className="process-step-icon text-success" />
            ) : null}
          </span>
          <span
            className={cn(
              'process-tool-label process-thought-label',
              isGenerating && 'process-thought-label--live',
            )}
          >
            {summary}
          </span>
          {!isGenerating && (
            <span className="process-thought-done shrink-0">Done</span>
          )}
          <ChevronDown
            className={cn(
              'process-tool-chevron',
              expanded && 'process-tool-chevron--open',
            )}
            aria-hidden
          />
        </button>
      ) : (
        <div className="process-tool-toggle process-thought-toggle" aria-hidden>
          <span className="process-step-gutter">
            {!isGenerating ? (
              <Check className="process-step-icon text-success" />
            ) : null}
          </span>
          <span className="process-tool-label process-thought-label">
            {summary}
          </span>
          {!isGenerating && (
            <span className="process-thought-done">Done</span>
          )}
        </div>
      )}

      {expanded && (
        <div
          id={panelId}
          className="process-thought-panel"
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
      )}
    </div>
  );
}
