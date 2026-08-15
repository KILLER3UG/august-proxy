/* ── RightDrawerSubagentsSection — compact roster + live detail ─────── */

import { CheckCircle2, CircleAlert, Loader2, Sparkles, Square, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  type SessionAgentRow,
} from '@/api/workbench';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { useSessionStreamStore } from '@/sections/chat/stream/session-stream-store';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';
import { WorkstreamsPanel } from '@/components/chat/WorkstreamsPanel';
import { closeRightDrawerSection } from '@/components/shell/RightDrawerState';
import { api } from '@/api/client';

const ACTIVE_STATUSES = new Set(['pending', 'running']);

const AVATAR_COLORS = [
  'text-violet-300 bg-violet-400/15',
  'text-emerald-300 bg-emerald-400/15',
  'text-orange-300 bg-orange-400/15',
  'text-cyan-300 bg-cyan-400/15',
];

function previewTranscriptContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

function statusText(status: string): string {
  if (ACTIVE_STATUSES.has(status)) return 'is working';
  if (status === 'completed' || status === 'recovered') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function AgentGlyph({ index, status }: { index: number; status: string }) {
  const Icon = ACTIVE_STATUSES.has(status)
    ? Loader2
    : status === 'completed' || status === 'recovered'
      ? CheckCircle2
      : CircleAlert;

  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md',
        AVATAR_COLORS[index % AVATAR_COLORS.length],
      )}
    >
      <Icon className={cn('size-3', ACTIVE_STATUSES.has(status) && 'animate-spin')} />
    </span>
  );
}

export function RightDrawerSubagentsSection({
  sessionId,
  workbenchSessionId,
  workspacePath,
}: {
  sessionId: string | null;
  workbenchSessionId: string | null;
  workspacePath?: string | null;
}) {
  const focused = useFocusedSubagent();
  const [openTaskIds, setOpenTaskIds] = useState<string[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { stop, stopAll, steer } = useSubagentActions();
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  useEffect(() => {
    if (!focused?.jobId) return;
    setOpenTaskIds((current) =>
      current.includes(focused.jobId) ? current : [...current, focused.jobId],
    );
    setSelectedTaskId(focused.jobId);
  }, [focused?.jobId]);
  const subagentBlocks = useSessionStreamStore((state) => {
    const session = sessionId ? state.bySession[sessionId] : undefined;
    return session?.subagentBlocks;
  });
  const subagentPrompts = useSessionStreamStore((state) => {
    const session = sessionId ? state.bySession[sessionId] : undefined;
    return session?.subagentPrompts;
  });
  const transcript = useQuery({
    queryKey: ['workbench-transcript', workbenchSessionId],
    queryFn: () =>
      api.get<{ messages?: Array<{ role?: string; content?: unknown }> }>(
        `/api/workbench/sessions/${encodeURIComponent(workbenchSessionId!)}/transcript`,
      ),
    enabled: !!workbenchSessionId,
  });
  const query = useQuery({
    queryKey: ['session-agents', workbenchSessionId],
    queryFn: () => listWorkbenchSessionAgents(workbenchSessionId!),
    enabled: !!workbenchSessionId,
    refetchInterval: (current) => {
      const agents = current.state.data?.agents ?? [];
      return agents.some((agent) => ACTIVE_STATUSES.has(agent.status)) ? 2_000 : 10_000;
    },
  });

  const activeAgents = (query.data?.agents ?? []).filter((agent) =>
    ACTIVE_STATUSES.has(agent.status),
  );
  const selectedBlock = selectedTaskId
    ? subagentBlocks?.get(selectedTaskId) ?? null
    : null;
  const selectedApiAgent = selectedTaskId
    ? query.data?.agents.find((agent) => agent.taskId === selectedTaskId) ?? null
    : null;
  const selectedAgent: SessionAgentRow | null = selectedApiAgent ?? (selectedBlock
    ? {
        taskId: selectedBlock.jobId,
        agentId: selectedBlock.agentId,
        goal: selectedBlock.task || '',
        status: selectedBlock.status,
      }
    : null);
  const agents = selectedAgent && !activeAgents.some((agent) => agent.taskId === selectedAgent.taskId)
    ? [...activeAgents, selectedAgent]
    : activeAgents;
  const openAgents = openTaskIds
    .map((taskId) => {
      const apiAgent = query.data?.agents.find((agent) => agent.taskId === taskId);
      if (apiAgent) return apiAgent;
      const block = subagentBlocks?.get(taskId);
      return block
        ? {
            taskId: block.jobId,
            agentId: block.agentId,
            goal: block.task || '',
            status: block.status,
          }
        : null;
    })
    .filter((agent): agent is SessionAgentRow => agent !== null);

  const selectAgent = (taskId: string) => {
    setOpenTaskIds((current) => (current.includes(taskId) ? current : [...current, taskId]));
    setSelectedTaskId(taskId);
  };

  const closeAgent = (taskId: string) => {
    setOpenTaskIds((current) => {
      const next = current.filter((id) => id !== taskId);
      setSelectedTaskId((selected) => {
        if (selected !== taskId) return selected;
        return next[next.length - 1] ?? null;
      });
      return next;
    });
  };

  const confirmStopAll = async () => {
    const ok = await confirmStyled({
      title: 'Stop all subagents?',
      message: `Stop ${activeAgents.length} running sub-agent${activeAgents.length === 1 ? '' : 's'}? Work in progress is discarded.`,
      confirmLabel: 'Stop all',
      variant: 'destructive',
    });
    if (ok) stopAll.mutate(workbenchSessionId ?? sessionId ?? undefined);
  };

  // Keep the completed detail visible long enough for its final output to be
  // read. If nobody opened a row, dismiss the progress-only section shortly
  // after the last worker settles.
  useEffect(() => {
    if (!query.data || activeAgents.length > 0 || openTaskIds.length > 0) return;
    const timer = window.setTimeout(() => closeRightDrawerSection('subagents'), 3_000);
    return () => window.clearTimeout(timer);
  }, [query.data, activeAgents.length, openTaskIds.length]);

  if (selectedTaskId && selectedAgent) {
    return (
      <div className="flex h-full min-h-0 flex-col drawer-section-text">
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1">
          {openAgents.map((agent) => (
            <div
              key={agent.taskId}
              className={cn(
                'group flex max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
                agent.taskId === selectedTaskId
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.05]',
              )}
            >
              <button
                type="button"
                onClick={() => setSelectedTaskId(agent.taskId)}
                className="min-w-0 truncate text-left"
                aria-label={`Show ${getAgentRoleLabel(agent.agentId)} details`}
              >
                {getAgentRoleLabel(agent.agentId)}
              </button>
              <button
                type="button"
                onClick={() => closeAgent(agent.taskId)}
                className="shrink-0 rounded p-0.5 text-muted-foreground/65 hover:bg-white/[0.08] hover:text-foreground"
                aria-label={`Remove ${getAgentRoleLabel(agent.agentId)} view`}
                title="Remove view"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
          data-testid={`right-drawer-subagent-view-${selectedTaskId}`}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {getAgentRoleLabel(selectedAgent.agentId)}
              </h3>
              <p className="text-xs text-muted-foreground/70">
                {statusText(selectedAgent.status)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => closeAgent(selectedTaskId)}
              className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              aria-label="Remove subagent view"
              title="Remove view"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {selectedBlock ? (
            <SubagentTimeline
              state={selectedBlock}
              subBlocks={subagentBlocks}
              subPrompts={subagentPrompts}
              hideTaskPrompt
            />
          ) : (
            <div className="text-xs italic text-muted-foreground/70">
              Waiting for subagent output…
            </div>
          )}
          {(selectedBlock?.workstream || selectedApiAgent?.workstream) ? (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              workstream {(selectedBlock?.workstream || selectedApiAgent?.workstream)}
            </p>
          ) : null}
          {ACTIVE_STATUSES.has(selectedAgent.status) ? (
            <form
              className="mt-3 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const message = String(fd.get('steer') || '').trim();
                if (!message) return;
                steer.mutate({ taskId: selectedTaskId, message });
                e.currentTarget.reset();
              }}
            >
              <input
                name="steer"
                className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1 text-xs"
                placeholder="Steer this worker (next round)…"
                aria-label="Steer subagent"
              />
              <button
                type="submit"
                disabled={steer.isPending}
                className="rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                Send
              </button>
            </form>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto drawer-section-text">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Subagents</span>
        <span className="inline-flex items-center gap-1.5">
          {activeAgents.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => void confirmStopAll()}
                disabled={stopAll.isPending}
                className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-danger/50 hover:text-danger disabled:opacity-40"
                title="Stop all running subagents"
                data-testid="stop-all-subagents"
              >
                <Square className="size-2.5" />
                Stop all
              </button>
              <span className="text-[11px] tabular-nums text-muted-foreground/55">
                {activeAgents.length}
              </span>
            </>
          )}
        </span>
      </div>

      {agents.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground/60">
          No active subagents.
        </div>
      ) : (
        <div className="border-t border-border/50 px-2 py-1">
          {agents.map((agent: SessionAgentRow, index) => (
            <div
              key={agent.taskId}
              className="group flex w-full min-w-0 items-center gap-2 border-b border-border/35 py-2 text-left last:border-b-0 hover:bg-white/[0.04]"
            >
              <button
                type="button"
                onClick={() => selectAgent(agent.taskId)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={agent.goal || agent.agentId}
                data-testid={`right-drawer-subagent-${agent.taskId}`}
              >
                <AgentGlyph index={index} status={agent.status} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                  {getAgentRoleLabel(agent.agentId) || agent.goal || 'Agent'}
                </span>
                {agent.workstream ? (
                  <span className="max-w-[5rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">
                    {agent.workstream}
                  </span>
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground/65">
                  {statusText(agent.status)}
                </span>
              </button>
              {ACTIVE_STATUSES.has(agent.status) && (
                <button
                  type="button"
                  onClick={() => stop.mutate(agent.taskId)}
                  disabled={stop.isPending}
                  className="shrink-0 rounded p-1 text-muted-foreground/55 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-danger disabled:opacity-40"
                  aria-label={`Stop ${getAgentRoleLabel(agent.agentId)}`}
                  title="Stop this subagent"
                  data-testid={`stop-subagent-${agent.taskId}`}
                >
                  <Square className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <WorkstreamsPanel
          sessionId={workbenchSessionId}
          compact
          workspacePath={workspacePath}
        />
      {(transcript.data?.messages?.length ?? 0) > 0 ? (
        <details className="mx-2 mb-3 rounded-lg border border-border/40 bg-muted/10 px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            Full run ({transcript.data!.messages!.length} messages)
          </summary>
          <ol className="mt-2 max-h-64 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
            {transcript.data!.messages!.slice(-40).map((m, i) => (
              <li key={i} className="line-clamp-3">
                <span className="font-medium text-foreground/70">{m.role ?? 'msg'}: </span>
                {previewTranscriptContent(m.content)}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {query.isError && (
        <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-destructive/75">
          <Sparkles className="size-3" />
          Unable to refresh subagents.
        </div>
      )}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
