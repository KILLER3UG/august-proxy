/**
 * SubagentLaunchList — Cursor-style "Checked to-do list" for parallel subagents.
 * Click a row to expand an inline card in the chat (not a centered modal).
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import {
  SUBAGENT_STATUS_LABEL,
  type SubagentPromptEntry,
} from '@/components/chat/subagent-tools';
import { SubagentExpandedCard } from '@/components/chat/SubagentExpandedCard';

interface SubagentLaunchListProps {
  agents: SubagentBlockState[];
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  className?: string;
}

function taskTitle(state: SubagentBlockState): string {
  const task = state.task?.trim();
  if (task) return task;
  return getAgentRoleLabel(state.agentId);
}

export function SubagentLaunchList({
  agents,
  subBlocks,
  subPrompts,
  modelLabel,
  className,
}: SubagentLaunchListProps) {
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  if (agents.length === 0) return null;

  const openState =
    openJobId
      ? agents.find((a) => a.jobId === openJobId) ??
        subBlocks?.get(openJobId) ??
        null
      : null;

  const liveOpen = openState
    ? subBlocks?.get(openState.jobId) ?? openState
    : null;

  return (
    <div
      className={cn('mt-1.5 space-y-1', className)}
      data-slot="subagent-launch-list"
    >
      {!liveOpen ? (
        <>
          <div className="text-[12px] text-muted-foreground/75 px-0.5">
            Checked to-do list
          </div>
          <ul className="flex flex-col gap-2" role="list">
            {agents.map((agent) => {
              const title = taskTitle(agent);
              const statusLabel = SUBAGENT_STATUS_LABEL[agent.status];
              return (
                <li key={agent.jobId}>
                  <button
                    type="button"
                    onClick={() => setOpenJobId(agent.jobId)}
                    className={cn(
                      'group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md px-0.5 py-0.5 text-left',
                      'hover:bg-white/[0.03] transition-colors',
                    )}
                    data-subagent-id={agent.jobId}
                    data-subagent-status={agent.status}
                    data-testid={`subagent-launch-row-${agent.jobId}`}
                  >
                    <span
                      className="col-start-1 row-start-1 mt-[2px] text-[13px] leading-5 text-muted-foreground/70 select-none"
                      aria-hidden
                    >
                      •
                    </span>
                    <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2 text-[13px] leading-5">
                      <span className="min-w-0 truncate text-foreground/90">
                        {title}
                      </span>
                      {modelLabel ? (
                        <span className="ml-auto shrink-0 text-[12px] text-muted-foreground/55">
                          {modelLabel}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'col-start-2 row-start-2 text-[12px] leading-4',
                        agent.status === 'running' && 'text-muted-foreground/80',
                        agent.status === 'completed' && 'text-muted-foreground/70',
                        agent.status === 'failed' && 'text-destructive/80',
                        agent.status === 'cancelled' && 'text-muted-foreground/55',
                      )}
                    >
                      {statusLabel}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <SubagentExpandedCard
          state={liveOpen}
          subBlocks={subBlocks}
          subPrompts={subPrompts}
          modelLabel={modelLabel}
          onClose={() => setOpenJobId(null)}
          onOpenAgent={(jobId) => setOpenJobId(jobId)}
        />
      )}
    </div>
  );
}
