/* ── SubagentDelegateRow — inline transcript row for a delegated worker ── */
/* Part 27 A1: reverses the "drawer-only" decision — every launched agent
   gets one first-class row where the user is reading. Clicking it focuses
   that agent's tab in the right drawer. */

import { useEffect, useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';

export interface SubagentDelegateRowProps {
  jobId?: string;
  agentId: string;
  task: string;
  /** Live container status when present; tool-call status when reloaded. */
  status: 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'done' | 'error';
  startedAt?: number;
  finishedAt?: number;
  workstream?: string;
}

/** Normalize a start time that may arrive in epoch seconds (backend seed)
 *  or milliseconds (SSE path) — mixing them showed ~1.7e9 "seconds". */
function toMs(t: number): number {
  return t > 1e12 ? t : t * 1000;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

export function SubagentDelegateRow({
  jobId,
  agentId,
  task,
  status,
  startedAt,
  finishedAt,
  workstream,
}: SubagentDelegateRowProps) {
  const running = status === 'running' || status === 'pending';
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Date.now() - toMs(startedAt) : 0,
  );

  useEffect(() => {
    if (!running || !startedAt) return;
    const id = window.setInterval(() => setElapsed(Date.now() - toMs(startedAt)), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);

  const role = getAgentRoleLabel(agentId);
  const failed = status === 'failed' || status === 'error';
  const cancelled = status === 'cancelled';

  const open = () => {
    if (!jobId) return;
    setFocusedSubagent({
      jobId,
      title: task || role,
      workstream: workstream?.trim() || undefined,
      running,
    });
    addRightDrawerSection('subagents');
  };

  return (
    <button
      type="button"
      onClick={open}
      disabled={!jobId}
      className={cn(
        'subagent-delegate-row row-enter group flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] leading-5 transition-colors',
        jobId && 'hover:bg-white/[0.03]',
      )}
      data-testid="subagent-delegate-row"
      data-subagent-id={jobId}
      data-subagent-status={status}
      title={task || undefined}
    >
      <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground/90">
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-primary/80" aria-hidden />
        ) : (
          <Bot className="size-3.5 text-muted-foreground/70" aria-hidden />
        )}
        SubAgent
      </span>
      <span className="shrink-0 text-info/90">{role}</span>
      <span className="shrink-0 text-muted-foreground/40" aria-hidden>
        ·
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
        {task || role}
      </span>
      {running && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {fmtElapsed(elapsed)}
        </span>
      )}
      {failed && (
        <span className="shrink-0 text-[11px] text-destructive/80 underline decoration-dotted underline-offset-2">
          Failed
        </span>
      )}
      {cancelled && (
        <span className="shrink-0 text-[11px] text-muted-foreground/60 underline decoration-dotted underline-offset-2">
          Cancelled
        </span>
      )}
    </button>
  );
}
