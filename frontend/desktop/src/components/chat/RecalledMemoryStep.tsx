/**
 * Recalled-memory step: collapsed one-liner "Recalled: {category} — {snippet}",
 * same visual language as ToolStepRow (process-step / process-tool-* classes)
 * so it reads as just another card in the process timeline. Expands to the
 * full list of auto-memory rows that were prefetched into this turn.
 */

import { BrainCircuit } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RecalledMemoryItem } from '@/types/chat';

function humanizeCategory(category: string): string {
  if (!category) return 'Memory';
  return category
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function truncate(text: string, n: number): string {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  return clean.length <= n ? clean : `${clean.slice(0, n - 1).trimEnd()}…`;
}

export function RecalledMemoryStep({
  memories,
  expanded,
  onToggle,
}: {
  memories: RecalledMemoryItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!memories || memories.length === 0) return null;
  const first = memories[0];
  const extra = memories.length - 1;
  const label = `Recalled: ${humanizeCategory(first.category)} — ${truncate(first.snippet || first.key, 72)}${
    extra > 0 ? ` +${extra} more` : ''
  }`;

  return (
    <div className="process-step process-step--tool" data-slot="recalled-memory-step">
      <button
        type="button"
        className="process-tool-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="process-step-gutter" aria-hidden>
          <BrainCircuit className="process-step-icon-wrap" />
        </span>
        <span className="process-tool-label" title={label}>
          {label}
        </span>
        <ChevronDown
          className={cn('process-tool-chevron', expanded && 'process-tool-chevron--open')}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="process-tool-panel">
          <div className="process-tool-response-label">Recalled memories</div>
          <div className="process-tool-response space-y-1.5">
            {memories.map((m, i) => (
              <div key={m.id || m.key || i} className="flex items-start gap-2 text-[12.5px]">
                <span className="shrink-0 rounded border border-border/50 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  {humanizeCategory(m.category)}
                </span>
                <span className="text-muted-foreground/90 min-w-0 break-words">
                  {m.snippet || m.key || '(no preview)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
