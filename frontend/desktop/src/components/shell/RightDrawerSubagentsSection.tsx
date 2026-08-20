/* ── RightDrawerSubagentsSection — compact roster + live detail ─────── */

import { CheckCircle2, CircleAlert, Loader2, Sparkles, Square, X, Settings2, Plus, Clock3 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  type SessionAgentRow,
} from '@/api/workbench';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { useSessionStreamStore } from '@/sections/chat/stream/session-stream-store';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';
import { WorkstreamsPanel } from '@/components/chat/WorkstreamsPanel';
import { closeRightDrawerSection } from '@/components/shell/RightDrawerState';
import { api } from '@/api/client';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'stalling']);

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
  if (status === 'stalling') return 'stalling · no progress — interrupting';
  if (status === 'queued') return 'queued · waiting for slot';
  if (ACTIVE_STATUSES.has(status)) return 'is working';
  if (status === 'completed' || status === 'recovered') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function AgentGlyph({ index, status }: { index: number; status: string }) {
  const Icon =
    status === 'queued'
      ? Clock3
      : ACTIVE_STATUSES.has(status)
        ? Loader2
        : status === 'completed' || status === 'recovered'
          ? CheckCircle2
          : CircleAlert;

  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md',
        AVATAR_COLORS[index % AVATAR_COLORS.length],
        status === 'queued' && 'opacity-60',
      )}
    >
      <Icon className={cn('size-3', ACTIVE_STATUSES.has(status) && status !== 'queued' && 'animate-spin')} />
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
  const [showHarnessConfig, setShowHarnessConfig] = useState(false);
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
  const workbenchSession = useSessionStreamStore((state) => {
    const s = sessionId ? state.bySession[sessionId] : undefined;
    return (s?.workbenchSession as unknown as { goal?: string; lastGoal?: string } | null) ?? null;
  });
  const transcript = useQuery({
    queryKey: ['workbench-transcript', workbenchSessionId],
    queryFn: () =>
      api.get<{ messages?: Array<{ role?: string; content?: unknown }> }>(
        `/api/workbench/sessions/${encodeURIComponent(workbenchSessionId!)}/transcript`,
      ),
    enabled: !!workbenchSessionId,
  });
  // Persisted runs (durable, survives restart / eviction) — fallback when live blocks are gone
  const runsQuery = useQuery({
    queryKey: ['subagent-runs', workbenchSessionId ?? sessionId],
    queryFn: () => {
      const sid = workbenchSessionId ?? sessionId ?? '';
      return api.get<{
        runs: Array<{
          task_id: string;
          taskId?: string;
          agent_id: string;
          agentId?: string;
          goal?: string;
          status: string;
          result_summary?: string;
          resultSummary?: string;
          result_full?: string;
          resultFull?: string;
          error?: string;
          started_at?: string;
          finished_at?: string;
        }>;
      }>(`/api/subagents/runs?sessionId=${encodeURIComponent(sid)}`);
    },
    enabled: !!(workbenchSessionId ?? sessionId),
    refetchInterval: 10_000,
  });
  // Hermes-style well-structured harness config
  const delegationQuery = useQuery({
    queryKey: ['delegation-config', workbenchSessionId ?? sessionId],
    queryFn: () => {
      const sid = workbenchSessionId ?? sessionId ?? '';
      return api.get<{ maxConcurrent: number; maxIterations: number; maxDepth: number; worktreeIsolation: boolean }>(
        `/api/subagents/config?sessionId=${encodeURIComponent(sid)}`,
      );
    },
    enabled: !!(workbenchSessionId ?? sessionId),
    staleTime: 30_000,
  });
  const qc = useQueryClient();
  const updateDelegation = useMutation({
    mutationFn: (patch: Partial<{ maxConcurrent: number; maxIterations: number; maxDepth: number; worktreeIsolation: boolean }>) => {
      const sid = workbenchSessionId ?? sessionId ?? '';
      return api.post(`/api/subagents/config?sessionId=${encodeURIComponent(sid)}`, patch);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['delegation-config'] });
    },
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
  // Persisted runs — durable fallback when handles are pruned or after restart.
  // Normalized to SessionAgentRow shape so the roster can show completed rows
  // even when `subagentBlocks` is empty (evicted by LRU or page reload).
  const persistedRuns = useMemo(() => {
    const runs = (runsQuery.data as { runs?: Array<Record<string, unknown>> } | undefined)?.runs ?? [];
    return runs.slice(0, 12).map((r) => {
      const taskId = String((r.taskId ?? r.task_id ?? '') as string);
      const agentId = String((r.agentId ?? r.agent_id ?? 'general') as string);
      const goal = String((r.goal ?? '') as string);
      const status = String((r.status ?? 'completed') as string);
      const error = String((r.error ?? '') as string);
      const resultSummary = String((r.resultSummary ?? r.result_summary ?? '') as string);
      const resultFull = String((r.resultFull ?? r.result_full ?? r.resultSummary ?? r.result_summary ?? '') as string);
      const lastActivityAt = (r.lastActivityAt ?? r.last_activity_at) as string | undefined;
      const apiCalls = (r.apiCalls ?? r.api_calls) as number | undefined;
      return { taskId, agentId, goal, status, error, resultSummary, resultFull, lastActivityAt, apiCalls } as SessionAgentRow & { resultSummary: string; resultFull: string; lastActivityAt?: string; apiCalls?: number; queuePosition?: number; queueTotal?: number };
    });
  }, [runsQuery.data]);
  const selectedBlock = selectedTaskId
    ? subagentBlocks?.get(selectedTaskId) ?? null
    : null;
  const selectedApiAgent = selectedTaskId
    ? query.data?.agents.find((agent) => agent.taskId === selectedTaskId) ?? null
    : null;
  const selectedRun = selectedTaskId
    ? (persistedRuns.find((r) => r.taskId === selectedTaskId) ?? null)
    : null;
  const selectedAgent: SessionAgentRow | null = selectedApiAgent
    ?? (selectedRun as unknown as SessionAgentRow | null)
    ?? (selectedBlock
      ? {
          taskId: selectedBlock.jobId,
          agentId: selectedBlock.agentId,
          goal: selectedBlock.task || '',
          status: selectedBlock.status,
        }
      : null);
  // Roster: live first, then recent persisted when idle (so “No active subagents” still shows finished work)
  const recentPersistedAgents = persistedRuns.filter((r) => !activeAgents.some((a) => a.taskId === r.taskId)).slice(0, 6) as SessionAgentRow[];
  const allAgents: SessionAgentRow[] = activeAgents.length > 0
    ? (selectedAgent && !activeAgents.some((a) => a.taskId === selectedAgent.taskId) ? [...activeAgents, selectedAgent] : activeAgents)
    : (persistedRuns.length > 0 ? (recentPersistedAgents as SessionAgentRow[]) : (selectedAgent && !activeAgents.some((a) => a.taskId === selectedAgent.taskId) ? [...activeAgents, selectedAgent] : activeAgents));
  const agents = allAgents;
  const openAgents = openTaskIds
    .map((taskId) => {
      const apiAgent = query.data?.agents.find((agent) => agent.taskId === taskId);
      if (apiAgent) return apiAgent;
      const run = persistedRuns.find((r) => r.taskId === taskId);
      if (run) return run as unknown as SessionAgentRow;
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

  const selectedTranscript = useQuery({
    queryKey: ['subagent-transcript', selectedTaskId],
    queryFn: () => api.get<{ taskId: string; events: Array<Record<string, unknown>> }>(`/api/subagents/${encodeURIComponent(selectedTaskId!)}/transcript`),
    enabled: !!selectedTaskId,
    refetchInterval: 2000,
  });

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
  // read. Drawer is drawer-only — don't auto-dismiss while a final output
  // is visible or a run was just persisted. If nobody opened a row, dismiss
  // after 15s (was 3s) so the output isn't lost.
  useEffect(() => {
    if (!query.data || activeAgents.length > 0 || openTaskIds.length > 0) return;
    // If there are persisted recent runs, keep the section so the user can
    // still open the finished row and read its result (bugfix: final output missing after reload).
    if (persistedRuns.length > 0) return;
    const timer = window.setTimeout(() => closeRightDrawerSection('subagents'), 15_000);
    return () => window.clearTimeout(timer);
  }, [query.data, activeAgents.length, openTaskIds.length, persistedRuns.length]);

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
            <>
              <SubagentTimeline
                state={selectedBlock}
                subBlocks={subagentBlocks}
                subPrompts={subagentPrompts}
                hideTaskPrompt
              />
              {/* Fallback persisted output when live timeline has no final response but DB does (e.g. capped worker emitted result but stream missed last chunk) */}
              {(() => {
                const hasFinal = selectedBlock.blocks.some((b) => b.type === 'finalOutput' && (b.content || '').trim());
                if (hasFinal) return null;
                const fallback =
                  (selectedRun as unknown as { resultFull?: string; result_full?: string; resultSummary?: string } | null)?.resultFull?.trim() ||
                  (selectedRun as unknown as { resultFull?: string; result_full?: string; resultSummary?: string } | null)?.result_full?.trim() ||
                  (selectedRun as unknown as { resultSummary?: string } | null)?.resultSummary?.trim() ||
                  (selectedApiAgent as unknown as { resultFull?: string; result_full?: string; resultSummary?: string } | null)?.resultFull?.trim() ||
                  (selectedApiAgent as unknown as { resultFull?: string; result_full?: string; resultSummary?: string } | null)?.result_full?.trim() ||
                  (selectedApiAgent as unknown as { resultSummary?: string } | null)?.resultSummary?.trim() ||
                  '';
                if (!fallback) return null;
                return (
                  <div className="mt-3 rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Persisted final response</div>
                    <div className="text-sm chat-message-text max-w-none">
                      <Markdown content={fallback} />
                    </div>
                  </div>
                );
              })()}
            </>
          ) : selectedRun ? (
            <div className="space-y-3">
              {(selectedRun as unknown as { goal?: string }).goal ? (
                <div className="rounded-lg border border-white/[0.05] bg-black/15 px-3 py-2 text-[13px] leading-relaxed text-foreground/80">
                  <pre className="m-0 whitespace-pre-wrap break-words font-sans">{String((selectedRun as unknown as { goal?: string }).goal)}</pre>
                </div>
              ) : null}
              {((selectedRun as unknown as { resultFull?: string; result_full?: string })?.resultFull ||
                (selectedRun as unknown as { resultFull?: string; result_full?: string })?.result_full ||
                (selectedRun as unknown as { resultSummary?: string })?.resultSummary) ? (
                <div className="text-sm chat-message-text" data-slot="subagent-final-output">
                  <Markdown
                    content={String(
                      (selectedRun as unknown as { resultFull?: string; result_full?: string; resultSummary?: string }).resultFull ??
                        (selectedRun as unknown as { resultFull?: string; result_full?: string; resultSummary?: string }).result_full ??
                        (selectedRun as unknown as { resultSummary?: string }).resultSummary,
                    )}
                  />
                </div>
              ) : (selectedRun as unknown as { error?: string }).error ? (
                <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
                  {(selectedRun as unknown as { error?: string }).error}
                </div>
              ) : (
                <div className="text-xs italic text-muted-foreground/70">No final response recorded.</div>
              )}
              {(selectedRun as unknown as { error?: string }).error &&
              ((selectedRun as unknown as { resultFull?: string; result_full?: string })?.resultFull ||
                (selectedRun as unknown as { resultFull?: string; result_full?: string })?.result_full ||
                (selectedRun as unknown as { resultSummary?: string })?.resultSummary) ? (
                <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
                  {(selectedRun as unknown as { error?: string }).error}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-xs italic text-muted-foreground/70">
              Waiting for subagent output…
            </div>
          )}
          {(selectedBlock?.workstream || selectedApiAgent?.workstream || (selectedRun as unknown as { workstream?: string } | null)?.workstream) ? (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              workstream {(selectedBlock?.workstream || selectedApiAgent?.workstream || (selectedRun as unknown as { workstream?: string }).workstream)}
            </p>
          ) : null}
          {selectedTranscript.data?.events && selectedTranscript.data.events.length > 0 && (
            <details className="mt-2 rounded border border-border/40 bg-muted/20 px-2 py-1.5" open={ACTIVE_STATUSES.has(selectedAgent.status)}>
              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">Live transcript · {selectedTranscript.data.events.length} events</summary>
              <div className="mt-1 max-h-40 overflow-y-auto font-mono text-[10px] leading-snug text-muted-foreground/80 space-y-0.5">
                {selectedTranscript.data.events.slice(-30).map((ev, i) => (
                  <div key={i} className="truncate">
                    <span className="text-foreground/60">{String(ev.type ?? 'event')}</span>
                    {ev.type === 'subagentText' && ev.content ? ` · ${String(ev.content).slice(0, 120)}` : ''}
                    {ev.type === 'subagentToolCall' && ev.name ? ` · ${String(ev.name)}` : ''}
                    {ev.type === 'subagentToolResult' && ev.summary ? ` · ${String(ev.summary).slice(0, 120)}` : ''}
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/60">
            <span>
              {(selectedBlock as unknown as { apiCalls?: number })?.apiCalls ??
                (selectedApiAgent as unknown as { apiCalls?: number })?.apiCalls ??
                (selectedRun as unknown as { apiCalls?: number })?.apiCalls ??
                0}{' '}
              api calls
            </span>
            <span>·</span>
            <span>
              {(selectedBlock as unknown as { iterations?: number })?.iterations ??
                (selectedApiAgent as unknown as { iterations?: number })?.iterations ??
                0}{' '}
              iters
            </span>
            {selectedAgent.status === 'stalling' && <span className="text-amber-600">· stalling · no progress</span>}
          </div>
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

      {/* Hermes-structured harness bar — well-structured delegation */}
      <div className="mx-2 mb-2 rounded-lg border border-border/40 bg-muted/10 px-2 py-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">Harness</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowHarnessConfig((v) => !v)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Harness config"
              aria-label="Harness config"
            >
              <Settings2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('august:open-spawn'))}
              className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="size-3" /> Delegate
            </button>
          </div>
        </div>
        {showHarnessConfig && delegationQuery.data && (
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Concurrency</span>
              <select
                value={delegationQuery.data.maxConcurrent}
                onChange={(e) => updateDelegation.mutate({ maxConcurrent: Number(e.target.value) })}
                className="rounded border border-border bg-background px-1 py-1"
              >
                {[1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Iterations</span>
              <select
                value={delegationQuery.data.maxIterations}
                onChange={(e) => updateDelegation.mutate({ maxIterations: Number(e.target.value) })}
                className="rounded border border-border bg-background px-1 py-1"
              >
                {[10, 25, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 pt-4">
              <input
                type="checkbox"
                checked={!!delegationQuery.data.worktreeIsolation}
                onChange={(e) => updateDelegation.mutate({ worktreeIsolation: e.target.checked })}
              />
              <span>Worktree</span>
            </label>
          </div>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground/60">
          Isolated context · fresh conversation · only final summary enters parent
        </p>
        {activeAgents.length > 0 && (
          <p className="text-[10px] text-muted-foreground/60">
            Background delegations: {activeAgents.length} running
            {activeAgents.some((a) => (a as unknown as { rawStatus?: string }).rawStatus === 'running' || a.status === 'stalling') ? ' · stall monitor active' : ''}
          </p>
        )}
      </div>

      {(workbenchSession?.goal || workbenchSession?.lastGoal) && (
        <div className="mx-2 mb-2 rounded-lg border border-primary/20 bg-primary/5 px-2 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-primary/70">Goal</div>
          <p className="mt-0.5 text-[12px] leading-snug text-foreground/90">{workbenchSession.goal || workbenchSession.lastGoal}</p>
          {workbenchSession?.lastGoal && workbenchSession?.goal && workbenchSession.lastGoal !== workbenchSession.goal && (
            <p className="mt-1 text-[10px] text-muted-foreground/60">Last: {workbenchSession.lastGoal}</p>
          )}
        </div>
      )}

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
                  {(agent as unknown as { queuePosition?: number; queueTotal?: number }).queuePosition
                    ? ` · ${ (agent as unknown as { queuePosition: number }).queuePosition}/${(agent as unknown as { queueTotal: number }).queueTotal}`
                    : ''}
                  {(agent as unknown as { apiCalls?: number }).apiCalls ? ` · ${ (agent as unknown as { apiCalls: number }).apiCalls} calls` : ''}
                </span>
              </button>
              {(ACTIVE_STATUSES.has(agent.status) || agent.status === 'queued') && (
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
