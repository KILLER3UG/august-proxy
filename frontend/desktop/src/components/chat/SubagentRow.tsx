/* ── SubagentRow ─────────────────────────────────────────────── */
/* Single sub-agent row: goal, status pill, elapsed time.
   Click to expand an inline chat area showing thinking,
   tool calls, and commands — just like the main chat thread. */

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertCircle, StopCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentInfo } from '@/api/subagents';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';

interface SubagentRowProps {
  agent: SubagentInfo;
  subagentBlock?: SubagentBlockState;
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

export function SubagentRow({ agent, subagentBlock }: SubagentRowProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = STATUS_ICON[agent.status] || Loader2;
  const [elapsed, setElapsed] = useState(agent.elapsed);

  useEffect(() => {
    if (agent.status === 'running') {
      // Normalize the start time: the backend seeds startedAt in epoch
      // SECONDS while the SSE path stores ms — mixing units made the
      // running timer display ~1.7e9 "seconds" (audit finding).
      const startedMs = agent.startedAt > 1e12 ? agent.startedAt : agent.startedAt * 1000;
      const interval = setInterval(() => {
        setElapsed((Date.now() - startedMs) / 1000);
      }, 200);
      return () => clearInterval(interval);
    }
    setElapsed(agent.elapsed);
  }, [agent.status, agent.startedAt, agent.elapsed]);

  const hasBlocks = subagentBlock && subagentBlock.blocks.length > 0;
  const isRunning = agent.status === 'running';
  const showChat = expanded && (hasBlocks || isRunning);

  return (
    <div
      className="rounded-lg border border-white/[0.06] bg-card/40 text-sm"
      data-testid={`subagent-row-${agent.taskId}`}
    >
      {/* Clickable header row */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
        aria-expanded={expanded}
        aria-controls={`subagent-chat-${agent.taskId}`}
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

        {hasBlocks && (
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        )}
      </button>

      {/* Inline chat area — shows thinking, tool calls, and commands */}
      {showChat ? (
        <div
          id={`subagent-chat-${agent.taskId}`}
          className="border-t border-white/[0.04] bg-black/[0.02]"
        >
          <div className="max-h-72 overflow-y-auto px-3 py-2 space-y-2">
            {subagentBlock ? (
              <SubagentTimeline
                state={subagentBlock}
                hideTaskPrompt
              />
            ) : isRunning ? (
              <div className="text-[11px] text-muted-foreground/70 italic py-1">
                Waiting for output…
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Non-block running indicator */}
      {isRunning && !hasBlocks && !expanded && (
        <div className="px-3 pb-2">
          <div className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-warning animate-pulse" />
            Running…
          </div>
        </div>
      )}
    </div>
  );
}
