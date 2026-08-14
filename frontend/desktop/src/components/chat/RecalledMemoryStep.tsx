/**
 * Recalled-memory chip: "Used N memories". Expand for snippets + pin.
 */

import { BrainCircuit, ChevronDown, Pin } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/api/client';
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

async function pinMemory(id: string) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    toast.error('Cannot pin this memory');
    return;
  }
  await api.put(`/api/memory/auto/${n}`, { pinned: true, source: 'user' });
  toast.success('Always include this memory');
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
  const navigate = useNavigate();
  if (!memories || memories.length === 0) return null;
  const n = memories.length;
  const label = n === 1 ? 'Used 1 memory' : `Used ${n} memories`;

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
          <span className="ml-1.5 text-muted-foreground/70">
            {truncate(memories[0].snippet || memories[0].key, 48)}
          </span>
        </span>
        <ChevronDown
          className={cn('process-tool-chevron', expanded && 'process-tool-chevron--open')}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="process-tool-panel">
          <div className="process-tool-response-label">Recalled this turn</div>
          <div className="process-tool-response space-y-1.5">
            {memories.map((m, i) => (
              <div key={m.id || m.key || i} className="flex items-start gap-2 text-[12.5px]">
                <span className="shrink-0 rounded border border-border/50 px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  {humanizeCategory(m.category)}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 break-words text-left text-muted-foreground/90 hover:text-foreground"
                  onClick={() => {
                    void navigate(`/settings/recalled-memory`);
                  }}
                >
                  {m.snippet || m.key || '(no preview)'}
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
                  title="Always include in this chat"
                  onClick={() => {
                    void pinMemory(m.id).catch(() => toast.error('Pin failed'));
                  }}
                >
                  <Pin className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
