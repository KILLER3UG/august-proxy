/**
 * SubagentLaunchList — horizontal worker lanes. Click a lane to open
 * the workers drawer (not a second chat in the bubble).
 */

import { Square } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { resolveWorkbenchSessionId } from '@/sections/chat/stream/session-id-map';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import {
  SUBAGENT_STATUS_LABEL,
  type SubagentPromptEntry,
} from '@/components/chat/subagent-tools';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import * as subagents from '@/api/subagents';

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
  subBlocks,
  subPrompts,
  modelLabel,
  className,
}: SubagentLaunchListProps) {
  void subBlocks;
  void subPrompts;
  const { stop } = useSubagentActions();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const workbenchSessionId = routeSessionId
    ? resolveWorkbenchSessionId(routeSessionId)
    : '';
  const workstream = agents.map((a) => a.workstream?.trim()).find(Boolean) || '';
  const episodes = useQuery({
    queryKey: ['workstream-episodes', workbenchSessionId, workstream],
    queryFn: () => subagents.listWorkstreamEpisodes(workbenchSessionId, workstream),
    enabled: !!workbenchSessionId && !!workstream,
  });

  if (agents.length === 0) return null;

  const openLane = (agent: SubagentBlockState) => {
    setFocusedSubagent({
      jobId: agent.jobId,
      title: taskTitle(agent),
      workstream: agent.workstream?.trim() || undefined,
      running: agent.status === 'running' || agent.status === 'pending',
    });
    addRightDrawerSection('subagents');
  };

  return (
    <div
      className={cn('mt-1.5 space-y-2', className)}
      data-slot="subagent-launch-list"
    >
          <div className="px-0.5 text-[12.5px] text-muted-foreground/70">Workers</div>
          <ul
            className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
            role="list"
          >
            {agents.map((agent) => {
              const title = taskTitle(agent);
              const statusLabel = SUBAGENT_STATUS_LABEL[agent.status];
              return (
                <li key={agent.jobId} className="min-w-[168px] max-w-[220px] shrink-0">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openLane(agent)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openLane(agent);
                      }
                    }}
                    className={cn(
                      'group flex h-full cursor-pointer flex-col gap-1 rounded-xl border border-border/50 bg-muted/10 px-2.5 py-2 text-left',
                      'hover:border-border hover:bg-white/[0.03] transition-colors',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                    )}
                    data-subagent-id={agent.jobId}
                    data-subagent-status={agent.status}
                    data-testid={`subagent-launch-row-${agent.jobId}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          agent.status === 'running' && 'animate-pulse bg-primary',
                          agent.status === 'completed' && 'bg-success',
                          agent.status === 'failed' && 'bg-destructive',
                          agent.status === 'cancelled' && 'bg-muted-foreground/40',
                          agent.status === 'partial' && 'bg-warning',
                        )}
                        aria-hidden
                      />
                      <span
                        className={cn(
                          'min-w-0 truncate text-[11px]',
                          agent.status === 'running' && 'text-muted-foreground/80',
                          agent.status === 'completed' && 'text-muted-foreground/70',
                          agent.status === 'failed' && 'text-destructive/80',
                          agent.status === 'cancelled' && 'text-muted-foreground/55',
                        )}
                      >
                        {statusLabel}
                      </span>
                      {agent.status === 'running' && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            stop.mutate(agent.jobId);
                          }}
                          disabled={stop.isPending}
                          className="ml-auto rounded p-0.5 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-danger disabled:opacity-40"
                          aria-label={`Stop ${title}`}
                          title="Stop this subagent"
                          data-testid={`stop-launch-${agent.jobId}`}
                        >
                          <Square className="size-2.5" />
                        </button>
                      )}
                    </div>
                    <span className="line-clamp-2 text-[13px] leading-5 text-foreground/90">
                      {title}
                    </span>
                    {modelLabel ? (
                      <span className="truncate text-[11px] text-muted-foreground/50">
                        {modelLabel}
                      </span>
                    ) : null}
                    {(agent.skills?.length ?? 0) > 0 ? (
                      <span className="truncate text-[10px] text-muted-foreground/55">
                        {agent.skills!.slice(0, 3).join(' · ')}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {(episodes.data?.length ?? 0) > 0 ? (
            <p className="px-0.5 font-mono text-[11px] text-muted-foreground/70" data-testid="workstream-episode-strip">
              {(() => {
                const ep = (episodes.data ?? [])[(episodes.data ?? []).length - 1];
                const next = (ep.next || ep.summary || '').trim();
                const ws = workstream || 'lane';
                return `${ws} #${ep.seq} ${ep.status || ''} → ${next}`.replace(/\s+/g, ' ').trim();
              })()}
            </p>
          ) : null}
    </div>
  );
}
