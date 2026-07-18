/**
 * SubagentLaunchList — Cursor-style "Checked to do list" for parallel subagents.
 * Click a row to open SubagentDetailModal.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import {
  SUBAGENT_STATUS_LABEL,
  type SubagentPromptEntry,
} from '@/components/chat/subagent-tools';
import { SubagentDetailModal } from '@/components/overlays/SubagentDetailModal';

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

function StatusDot({ status }: { status: SubagentBlockState['status'] }) {
  if (status === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === 'completed') {
    return (
      <span
        className="size-2.5 shrink-0 rounded-full bg-emerald-500"
        aria-hidden
      />
    );
  }
  if (status === 'failed') {
    return (
      <span
        className="size-2.5 shrink-0 rounded-full bg-destructive"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="size-2.5 shrink-0 rounded-full bg-muted-foreground/50"
      aria-hidden
    />
  );
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
    (openJobId
      ? agents.find((a) => a.jobId === openJobId)
        ?? subBlocks?.get(openJobId)
        ?? null
      : null);

  return (
    <>
      <div
        className={cn('mt-1.5 ml-1 space-y-1', className)}
        data-slot="subagent-launch-list"
      >
        <div className="text-[12px] text-muted-foreground/80 px-1">
          Checked to do list
        </div>
        <ul className="flex flex-col gap-0.5" role="list">
          {agents.map((agent) => {
            const title = taskTitle(agent);
            return (
              <li key={agent.jobId}>
                <button
                  type="button"
                  onClick={() => setOpenJobId(agent.jobId)}
                  className={cn(
                    'group flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-left',
                    'hover:bg-white/[0.03] transition-colors',
                  )}
                  data-subagent-id={agent.jobId}
                  data-subagent-status={agent.status}
                  data-testid={`subagent-launch-row-${agent.jobId}`}
                >
                  <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
                    <StatusDot status={agent.status} />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-5">
                    <span className="text-foreground/90">{title}</span>
                    {modelLabel ? (
                      <span className="text-muted-foreground/60">
                        {' '}
                        {modelLabel}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted-foreground/70 pt-0.5">
                    {SUBAGENT_STATUS_LABEL[agent.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {openState ? (
        <SubagentDetailModal
          state={
            // Prefer live map entry so the modal streams while open.
            subBlocks?.get(openState.jobId) ?? openState
          }
          subBlocks={subBlocks}
          subPrompts={subPrompts}
          modelLabel={modelLabel}
          onClose={() => setOpenJobId(null)}
          onOpenAgent={(jobId) => setOpenJobId(jobId)}
        />
      ) : null}
    </>
  );
}
