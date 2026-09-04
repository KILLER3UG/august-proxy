/* ── RightDrawerSubagentsSection — chat-style subagent transcript ──── */
/* ZCode parity: each delegated worker reads like another conversation — */
/* role label + status, then its result rendered with the SAME markdown  */
/* formatting as the main chat. No debug furniture: no harness config    */
/* bar, no goal cards, no api-call/iteration counters, no raw event      */
/* dumps, no "Persisted final response" labels.                          */

import { CheckCircle2, CircleAlert, Check, Circle, ArrowRight, ListTodo, Loader2, Square } from 'lucide-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  type SessionAgentRow,
} from '@/api/workbench';
import type { WorkbenchTodo } from '@/types/workbench';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { useSessionStreamStore } from '@/sections/chat/stream/session-stream-store';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { useSubagentActions } from '@/hooks/useSubagentActions';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';
import { closeRightDrawerSection } from '@/components/shell/RightDrawerState';
import { api } from '@/api/client';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'stalling']);

interface AgentRunRecord {
  taskId: string;
  agentId: string;
  goal: string;
  status: string;
  error?: string;
  /** Full persisted final output (markdown, rendered like chat text). */
  resultText: string;
  /** Per-agent todo list persisted with the run (drawer parity). */
  todos?: WorkbenchTodo[];
}

function parseTodos(raw: unknown): WorkbenchTodo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(
    (t): t is WorkbenchTodo =>
      !!t && typeof t === 'object' && typeof (t as WorkbenchTodo).content === 'string',
  );
  return out.length > 0 ? out : undefined;
}

function normalizeRun(r: Record<string, unknown>): AgentRunRecord {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  let todos: WorkbenchTodo[] | undefined;
  const rawTodos = r.todos ?? r.todosJson ?? r.todos_json;
  if (typeof rawTodos === 'string' && rawTodos.trim()) {
    try {
      todos = parseTodos(JSON.parse(rawTodos));
    } catch {
      todos = undefined;
    }
  } else {
    todos = parseTodos(rawTodos);
  }
  return {
    taskId: str('taskId', 'task_id'),
    agentId: str('agentId', 'agent_id') || 'general',
    goal: str('goal'),
    status: str('status') || 'completed',
    error: str('error') || undefined,
    resultText: str('resultFull', 'result_full', 'resultSummary', 'result_summary'),
    todos,
  };
}

function statusWord(status: string): string {
  if (status === 'stalling') return 'stalling';
  if (status === 'queued') return 'queued';
  if (ACTIVE_STATUSES.has(status)) return 'working';
  if (status === 'completed' || status === 'recovered') return 'done';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function StatusGlyph({ status }: { status: string }) {
  const Icon =
    status === 'queued'
      ? Loader2
      : ACTIVE_STATUSES.has(status)
        ? Loader2
        : status === 'completed' || status === 'recovered'
          ? CheckCircle2
          : CircleAlert;
  return (
    <Icon
      className={cn(
        'size-4 shrink-0',
        ACTIVE_STATUSES.has(status) && status !== 'queued' ? 'animate-spin text-primary/80' : '',
        (status === 'completed' || status === 'recovered') && 'text-emerald-400/80',
        status === 'failed' && 'text-danger/80',
        status === 'cancelled' && 'text-muted-foreground/50',
        status === 'queued' && 'text-muted-foreground/60',
      )}
    />
  );
}

/** Compact per-agent todo progress (drawer parity: workers own their lists). */
function TodoProgress({ todos }: { todos: WorkbenchTodo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div
      className="mb-3 rounded-md border border-border/40 bg-card/40 px-2.5 py-2"
      data-testid="subagent-todo-progress"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <ListTodo className="size-3" />
        Worker plan
        <span className="ml-auto font-mono tabular-nums normal-case tracking-normal">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-1" role="list">
        {todos.map((t, i) => (
          <li key={t.id || i} className="flex min-w-0 items-start gap-1.5 text-[12.5px] leading-5">
            {t.status === 'completed' ? (
              <Check className="mt-0.5 size-3 shrink-0 text-emerald-400/80" />
            ) : t.status === 'in_progress' ? (
              <ArrowRight className="mt-0.5 size-3 shrink-0 text-primary/80" />
            ) : (
              <Circle className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
            )}
            <span
              className={cn(
                'min-w-0',
                t.status === 'completed' && 'text-muted-foreground/60 line-through',
                t.status === 'in_progress' && 'text-foreground',
                t.status === 'pending' && 'text-muted-foreground/80',
              )}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RightDrawerSubagentsSection({
  sessionId,
  workbenchSessionId,
}: {
  sessionId: string | null;
  workbenchSessionId: string | null;
}) {
  const focused = useFocusedSubagent();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dismissArmedAt, setDismissArmedAt] = useState<number | null>(null);
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const { stop, stopAll, steer } = useSubagentActions();

  useEffect(() => {
    if (!focused?.jobId) return;
    setSelectedTaskId(focused.jobId);
  }, [focused?.jobId]);

  const subagentBlocks = useSessionStreamStore((state) => {
    const session = sessionId ? state.bySession[sessionId] : undefined;
    return session?.subagentBlocks;
  });

  // Persisted runs — durable history that survives restart / eviction.
  const runsQuery = useQuery({
    queryKey: ['subagent-runs', workbenchSessionId ?? sessionId],
    queryFn: async () => {
      const sid = workbenchSessionId ?? sessionId ?? '';
      const data = await api.get<{ runs?: Array<Record<string, unknown>> }>(
        `/api/subagents/runs?sessionId=${encodeURIComponent(sid)}`,
      );
      return (data.runs ?? []).map(normalizeRun);
    },
    enabled: !!(workbenchSessionId ?? sessionId),
    refetchInterval: 10_000,
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
  const runByTask = new Map((runsQuery.data ?? []).map((r) => [r.taskId, r]));

  /** Disambiguate same-role workers (two `general` agents): append an index
   *  so tab / row labels never collapse into identical text. */
  const roleLabels = (() => {
    const counts = new Map<string, number>();
    for (const e of query.data?.agents ?? []) {
      counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const out = new Map<string, string>();
    for (const e of query.data?.agents ?? []) {
      const base = getAgentRoleLabel(e.agentId);
      if ((counts.get(e.agentId) ?? 0) > 1) {
        const n = (seen.get(e.agentId) ?? 0) + 1;
        seen.set(e.agentId, n);
        out.set(e.taskId, `${base} ${n}`);
      } else {
        out.set(e.taskId, base);
      }
    }
    return out;
  })();

  /** Unified transcript entries, chronological: live first, then finished. */
  const entries: Array<{ key: string; agent: SessionAgentRow }> = (() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; agent: SessionAgentRow }> = [];
    for (const a of [...activeAgents, ...(query.data?.agents ?? [])]) {
      if (seen.has(a.taskId)) continue;
      seen.add(a.taskId);
      out.push({ key: a.taskId, agent: a });
    }
    for (const r of runsQuery.data ?? []) {
      if (seen.has(r.taskId)) continue;
      seen.add(r.taskId);
      out.push({
        key: r.taskId,
        agent: {
          taskId: r.taskId,
          agentId: r.agentId,
          goal: r.goal,
          status: r.status,
          todos: r.todos,
        },
      });
    }
    for (const [jobId, block] of subagentBlocks ?? []) {
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      out.push({
        key: jobId,
        agent: {
          taskId: block.jobId,
          agentId: block.agentId,
          goal: block.task || '',
          status: block.status,
        },
      });
    }
    return out;
  })();

  const selectedAgent = selectedTaskId
    ? entries.find((e) => e.key === selectedTaskId)?.agent ?? null
    : null;
  const selectedBlock = selectedTaskId ? subagentBlocks?.get(selectedTaskId) ?? null : null;

  // Auto-dismiss an empty section shortly after activity ends (kept from the
  // previous behavior, minus the drawer-hijack feel — only when truly idle).
  useEffect(() => {
    if (!query.data || activeAgents.length > 0 || entries.length > 0) {
      setDismissArmedAt(null);
      return;
    }
    if (dismissArmedAt === null) {
      setDismissArmedAt(Date.now());
      return;
    }
    const timer = window.setTimeout(() => {
      if (Date.now() - dismissArmedAt >= 14_000) closeRightDrawerSection('subagents');
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [query.data, activeAgents.length, entries.length, dismissArmedAt]);

  // Stop-all lives on the roster footer when several workers are active; the
  // confirmation dialog is shared with the per-row stop above.

  if (selectedTaskId && selectedAgent) {
    const run = runByTask.get(selectedTaskId);
    return (
      <div className="flex h-full min-h-0 flex-col drawer-section-text">
        {/* Open views — same tab strip language as the panel header */}
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/40 px-2 py-1">
          {[...new Set([selectedTaskId, ...entries.map((e) => e.key)])].map((taskId) => {
            const agent = entries.find((e) => e.key === taskId)?.agent;
            if (!agent) return taskId === selectedTaskId ? (
              <span key={taskId} className="rounded-md bg-primary/10 px-2 py-1 text-xs text-foreground">
                {roleLabels.get(taskId) ?? getAgentRoleLabel(selectedAgent.agentId)}
              </span>
            ) : null;
            return (
              <div
                key={taskId}
                className={cn(
                  'group flex max-w-[11rem] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
                  taskId === selectedTaskId
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-white/[0.05]',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTaskId(taskId)}
                  className="min-w-0 truncate text-left"
                >
                  {roleLabels.get(taskId) ?? getAgentRoleLabel(agent.agentId)}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTaskId((cur) => (cur === taskId ? null : cur))}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-white/[0.08] hover:text-foreground"
                  aria-label="Remove subagent view"
                  title="Remove view"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          data-testid={`right-drawer-subagent-view-${selectedTaskId}`}
        >
          {/* Chat-style header: who + status, nothing else. */}
          <div className="mb-3 flex items-center gap-2">
            <StatusGlyph status={selectedAgent.status} />
            <h3 className="truncate text-sm font-medium text-foreground">
              {roleLabels.get(selectedTaskId) ?? getAgentRoleLabel(selectedAgent.agentId)}
            </h3>
            <span className="text-xs text-muted-foreground/70">
              {statusWord(selectedAgent.status)}
            </span>
          </div>

          {run?.goal ? (
            <p className="mb-3 border-l-2 border-border/60 pl-3 text-[13px] leading-relaxed text-muted-foreground">
              {run.goal}
            </p>
          ) : null}

          {(() => {
            // Live handle todos (2s poll) are fresher than the persisted run
            // row (10s poll); prefer whichever has content.
            const agentTodos = (selectedAgent as { todos?: WorkbenchTodo[] }).todos;
            const list = agentTodos?.length ? agentTodos : run?.todos;
            return list?.length ? <TodoProgress todos={list} /> : null;
          })()}

          {selectedBlock ? (
            <>
              <SubagentTimeline
                state={selectedBlock}
                subBlocks={subagentBlocks}
                hideTaskPrompt
              />
              {!selectedBlock.blocks.some((b) => b.type === 'finalOutput' && (b.content || '').trim()) &&
                run?.resultText && (
                  <div className="chat-message-text mt-3 max-w-none text-sm">
                    <Markdown content={run.resultText} />
                  </div>
                )}
            </>
          ) : run?.resultText ? (
            /* Settled run: the result IS the conversation — same markdown as chat. */
            <div className="chat-message-text max-w-none text-sm" data-slot="subagent-final-output">
              <Markdown content={run.resultText} />
            </div>
          ) : selectedAgent.status === 'failed' || run?.error ? (
            <p className="text-[13px] leading-relaxed text-danger/85">
              {run?.error || 'The worker failed before producing a response.'}
            </p>
          ) : (
            <p className="text-[13px] italic leading-relaxed text-muted-foreground/70">
              Waiting for output…
            </p>
          )}

          {ACTIVE_STATUSES.has(selectedAgent.status) && (
            <form
              className="mt-4 flex items-center gap-1.5 border-t border-border/40 pt-3"
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
                placeholder="Message this worker…"
                aria-label="Steer subagent"
                className="min-w-0 flex-1 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
              />
              <button
                type="submit"
                disabled={steer.isPending}
                className="rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
              >
                Send
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto drawer-section-text" data-testid="right-drawer-subagents-list">
      {entries.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground/60">
          No subagents yet. Delegate a task and it will show up here like a second conversation.
        </p>
      ) : (
        <div className="px-1.5 py-1.5">
          {entries.map(({ key, agent }) => (
            <div key={key} className="group relative">
              <button
                type="button"
                onClick={() => setSelectedTaskId(key)}
                className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
                title={agent.goal || undefined}
                data-testid={`right-drawer-subagent-${key}`}
              >
                <StatusGlyph status={agent.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
                  {agent.goal || roleLabels.get(key) || getAgentRoleLabel(agent.agentId) || 'Agent'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground/55">
                  {agent.status === 'queued' && agent.queuePosition
                    ? `queued #${agent.queuePosition}${agent.queueTotal && agent.queueTotal > 1 ? `/${agent.queueTotal}` : ''}`
                    : statusWord(agent.status)}
                </span>
              </button>
              {(ACTIVE_STATUSES.has(agent.status) || agent.status === 'queued') && (
                <button
                  type="button"
                  onClick={() => stop.mutate(key)}
                  disabled={stop.isPending}
                  className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-danger"
                  aria-label={`Stop ${getAgentRoleLabel(agent.agentId)}`}
                  title="Stop this subagent"
                  data-testid={`stop-subagent-${key}`}
                >
                  <Square className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {activeAgents.length > 1 && (
        <div className="border-t border-border/30 px-3 py-2">
          <button
            type="button"
            onClick={() => void confirmStyled({
              title: 'Stop all subagents?',
              message: `Stop ${activeAgents.length} running sub-agent${activeAgents.length === 1 ? '' : 's'}? Work in progress is discarded.`,
              confirmLabel: 'Stop all',
              variant: 'destructive',
            }).then((ok) => {
              if (ok) stopAll.mutate(workbenchSessionId ?? sessionId ?? undefined);
            })}
            disabled={stopAll.isPending}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-danger"
            data-testid="stop-all-subagents"
          >
            <Square className="size-2.5" />
            Stop all ({activeAgents.length})
          </button>
        </div>
      )}
      {query.isError && (
        <p className="px-3 py-2 text-xs text-destructive/75">Unable to refresh subagents.</p>
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
