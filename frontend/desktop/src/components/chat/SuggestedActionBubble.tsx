/* eslint-disable react-refresh/only-export-components */

/* ── SuggestedActionBubble ─ post-turn follow-up suggestions ──────── */
/* A single pill anchored top-right of the chat scroll area. Appears     */
/* when the previous turn just completed and the user hasn't started     */
/* typing yet. Clicking queues the suggestion as the next user message   */
/* by setting the composer input (the user can edit before sending).     */
/*                                                                       */
/* Default suggestions cover the most common follow-ups for an edit-      */
/* heavy turn; the consumer can override via the `suggestions` prop.     */

import { ArrowRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DEFAULT_SUGGESTIONS: ReadonlyArray<string> = [
  'Summarize what just changed',
  'Run tests on the diff',
  'Add tests for the changes',
  'Commit the changes',
];

export interface SuggestedActionBubbleProps {
  /** List of suggestion strings (defaults to DEFAULT_SUGGESTIONS). */
  suggestions?: ReadonlyArray<string>;
  /** Called when the user clicks a suggestion. */
  onSelect: (suggestion: string) => void;
  /** Called when the user dismisses the bubble. */
  onDismiss?: () => void;
  /** When false, the bubble is hidden. */
  visible?: boolean;
  className?: string;
}

export function SuggestedActionBubble({
  suggestions = DEFAULT_SUGGESTIONS,
  onSelect,
  onDismiss,
  visible = true,
  className,
}: SuggestedActionBubbleProps) {
  if (!visible) return null;
  // Show only the first suggestion to keep the surface minimal (matches
  // the reference, which renders a single pill).
  const suggestion = suggestions[0];
  if (!suggestion) return null;

  return (
    <div
      className={cn(
        'flex justify-end px-1 pb-1.5 animate-in fade-in slide-in-from-top-2 duration-200',
        className
      )}
      role="region"
      aria-label="Suggested next action"
    >
      <div
        className="group relative inline-flex items-center gap-1.5 max-w-full"
        style={{
          backgroundColor: '#1b2839',
          border: '0.5px solid rgba(59,123,255,0.3)',
          borderRadius: 18,
          padding: '4px 6px 4px 11px',
          fontSize: 11.5,
          color: '#7fa8d0',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <button
          type="button"
          onClick={() => onSelect(suggestion)}
          className="flex items-center gap-1.5 hover:text-foreground/90 transition-colors min-w-0"
          title={`Send: ${suggestion}`}
        >
          <ArrowRight
            size={12}
            style={{ color: '#4a8fff', flexShrink: 0 }}
          />
          <span className="truncate">{suggestion}</span>
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-1 p-0.5 rounded hover:bg-white/10 text-muted-foreground/70 hover:text-foreground"
            aria-label="Dismiss suggestion"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
