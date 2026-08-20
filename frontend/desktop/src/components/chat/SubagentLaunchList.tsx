/**
 * Compact in-thread pointer to workers. Lane detail lives in the right
 * Workbench sidebar — the chat bubble only says how many are running.
 */

import { cn } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import type { SubagentPromptEntry } from '@/components/chat/subagent-tools';

interface SubagentLaunchListProps {
  agents: SubagentBlockState[];
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  className?: string;
}

function taskTitle(state: SubagentBlockState): string {
  const ws = state.workstream?.trim();
  const task = state.task?.trim();
  if (ws && task) return `${ws} — ${task}`;
  if (task) return task;
  if (ws) return ws;
  return getAgentRoleLabel(state.agentId);
}

export function SubagentLaunchList({
  agents,
  className,
}: SubagentLaunchListProps) {
  if (agents.length === 0) return null;

  const live = agents.filter((a) => a.status === 'running' || a.status === 'pending').length;
  const first = agents[0];

  const openWorkers = () => {
    if (first) {
      setFocusedSubagent({
        jobId: first.jobId,
        title: taskTitle(first),
        workstream: first.workstream?.trim() || undefined,
        running: first.status === 'running' || first.status === 'pending',
      });
    }
    addRightDrawerSection('subagents');
  };

  const label =
    live > 0
      ? `${live} worker${live === 1 ? '' : 's'} running`
      : `${agents.length} worker${agents.length === 1 ? '' : 's'}`;

  return (
    <div className={cn('mt-1.5', className)} data-slot="subagent-launch-list">
      <button
        type="button"
        onClick={openWorkers}
        className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border/50 bg-muted/10 px-2.5 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors hover:border-border hover:bg-white/[0.03] hover:text-foreground"
        data-testid="subagent-launch-open-sidebar"
        data-subagent-id={first?.jobId}
      >
        {live > 0 ? (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
        )}
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">Open in sidebar</span>
      </button>
    </div>
  );
}
