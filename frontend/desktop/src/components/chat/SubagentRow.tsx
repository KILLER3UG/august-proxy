/* ── SubagentRow ─────────────────────────────────────────────────────── */
/* Single sub-agent row: goal, status pill, current step, progress bar. */

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertCircle, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentInfo } from '@/api/subagents';

interface SubagentRowProps {
  agent: SubagentInfo;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  recovered: 'Recovered',
};

const STATUS_ICON: Record<string, typeof Loader2> = {
  pending: Loader2,
  running: Loader2,
  completed: CheckCircle2,
  failed: AlertCircle,
  cancelled: StopCircle,
  recovered: CheckCircle2,
};

const STATUS_CLASS: Record<string, string> = {
  pending: 'text-muted-foreground bg-muted/40',
  running: 'text-warning bg-warning/10',
  completed: 'text-success bg-success/10',
  failed: 'text-destructive bg-destructive/10',
  cancelled: 'text-muted-foreground bg-muted/40',
  recovered: 'text-success bg-success/10',
};

export function SubagentRow({ agent }: SubagentRowProps) {
  const Icon = STATUS_ICON[agent.status] || Loader2;
  const [elapsed, setElapsed] = useState(agent.elapsed);

  useEffect(() => {
    if (agent.status === 'running') {
      const interval = setInterval(() => {
        setElapsed((Date.now() - agent.startedAt) / 1000);
      }, 200);
      return () => clearInterval(interval);
    }
    setElapsed(agent.elapsed);
  }, [agent.status, agent.startedAt, agent.elapsed]);

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-card/40 px-3 py-2 text-sm"
      data-testid={`subagent-row-${agent.taskId}`}
    >
      <Icon
        className={cn(
          'size-4 shrink-0',
          agent.status === 'running' && 'animate-spin',
          agent.status === 'completed' && 'text-success',
          agent.status === 'failed' && 'text-destructive',
        )}
      />

      <div className="flex-1 min-w-0">
        <p className="truncate text-xs font-medium text-foreground/90">
          {agent.goal}
        </p>
        <p className="text-[10px] text-muted-foreground font-mono">
          {agent.agentId}
        </p>
      </div>

      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
          STATUS_CLASS[agent.status] || 'text-muted-foreground bg-muted/40',
        )}
      >
        {STATUS_LABEL[agent.status] || agent.status}
      </span>

      <span className="text-[10px] tabular-nums text-muted-foreground/60">
        {elapsed.toFixed(1)}s
      </span>
    </div>
  );
}
