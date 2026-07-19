/**
 * Claude-style thought step: icon gutter + muted rail prose.
 * No Thought (N) / disclosure chrome.
 */

import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';

export function ThoughtStep({
  content,
  isGenerating = false,
  className,
}: {
  content: string;
  isGenerating?: boolean;
  className?: string;
}) {
  const text = content.trim();
  if (!text && !isGenerating) return null;

  return (
    <div
      className={cn('process-step process-step--thought', className)}
      data-slot="thought-step"
      data-generating={isGenerating ? 'true' : 'false'}
    >
      <span className="process-step-gutter" aria-hidden>
        {isGenerating ? (
          <Loader2 className="process-step-icon animate-spin" />
        ) : (
          <RefreshCw className="process-step-icon" />
        )}
      </span>
      <div className="process-step-body">
        {text ? (
          <div className="process-thought-rail thought-content chat-thought-text">
            <Markdown content={text} />
          </div>
        ) : (
          <div className="process-thought-rail process-thought-pending">Thinking…</div>
        )}
      </div>
    </div>
  );
}
