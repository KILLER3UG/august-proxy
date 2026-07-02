/* ── SubagentPanel ───────────────────────────────────────────────────── */
/* Top-level card showing parallel sub-agent progress. Collapsed shows
   "X/Y agents complete" + Expand button. Expanded lists SubagentRows.
   Auto-dismisses 3 seconds after all agents complete. */

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSubagentStream } from '@/hooks/useSubagentStream';
import { useSubagentViewPreference } from '@/hooks/useSubagentViewPreference';
import { SubagentRow } from '@/components/chat/SubagentRow';

interface SubagentPanelProps {
  sessionId: string | null;
}

export function SubagentPanel({ sessionId }: SubagentPanelProps) {
  const { agents, loading, error } = useSubagentStream(sessionId);
  const { view, toggle } = useSubagentViewPreference();
  const [dismissed, setDismissed] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalCount = agents.length;
  const completedCount = agents.filter(
    (a) => a.status === 'completed' || a.status === 'recovered',
  ).length;
  const allDone = totalCount > 0 && completedCount === totalCount;
  const hasActive = agents.some((a) => a.status === 'running');

  // Auto-dismiss after 3s when all complete
  useEffect(() => {
    if (allDone && !hasActive) {
      dismissTimerRef.current = setTimeout(() => {
        setDismissed(true);
      }, 3000);
    }
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [allDone, hasActive]);

  if (totalCount === 0 || dismissed || error) return null;

  const isExpanded = view === 'expanded' && !allDone;

  return (
    <div
      className={cn(
        'rounded-xl border border-white/[0.06] bg-card/60 backdrop-blur-sm',
        'transition-all duration-300',
      )}
      data-testid="subagent-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          {loading && (
            <span className="size-2 rounded-full bg-warning animate-pulse" />
          )}
          <span className="text-[11px] font-medium text-foreground/80">
            {allDone
              ? `${completedCount}/${totalCount} agents complete`
              : `${completedCount}/${totalCount} agents`}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {totalCount > 1 && (
            <button
              type="button"
              onClick={toggle}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-white/[0.06]"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? (
                <Minimize2 className="size-3" />
              ) : (
                <Maximize2 className="size-3" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Expanded rows */}
      {isExpanded && (
        <div className="space-y-1.5 px-3 pb-3">
          {agents.map((agent) => (
            <SubagentRow key={agent.task_id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
