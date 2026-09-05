/* ── RightDrawerSubagentsSection — chat-style subagent transcript ──── */
/* Part 27 A2–A5: each delegated worker reads like another conversation —
   role label + status, then its result rendered with the SAME markdown
   formatting as the main chat. The tab strip labels workers by TASK TITLE +
   elapsed (not role), carries a search dropdown, and the selected view shows
   a live "Working for …" header, a Progress popover, and — after a reload —
   the full persisted work transcript replayed from the orchestrator jsonl.
   No debug furniture: no harness config bar, no goal cards, no api-call /
   iteration counters, no raw event dumps, no "Persisted final response" labels. */

import { CheckCircle2, CircleAlert, Check, Circle, ArrowRight, ListTodo, Loader2, Square, Search, ChevronDown } from 'lucide-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  listWorkbenchSessionAgents,
  type SessionAgentRow,
} from '@/api/workbench';
import { getSubagentTranscript } from '@/api/subagents';
import type { WorkbenchTodo } from '@/types/workbench';
import type { MessageBlock, AppendBlockEvent } from '@/types/chat';
import { appendBlockEvent } from '@/sections/chat/stream/append-block-event';
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

/** "31m 19s" / "42s" — the reference's tab + header elapsed format. */
function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

/** Map persisted orchestrator transcript events into chat blocks. The
 *  workbench emit dicts use the same camelCase types the live SSE path feeds
 *  appendBlockEvent, so replay is a filtered pass-through. Unknown event
 *  types (started/done/heartbeat) are skipped. */
const REPLAY_TYPES = new Set([
  'thinking',
  'text',
  'content',
  'finalOutput',
  'toolCall',
  'command',
  'toolResult',
  'error',
]);

function transcriptToBlocks(events: Array<Record<string, unknown>>): MessageBlock[] {
  let blocks: MessageBlock[] = [];
  for (const ev of events) {
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (!REPLAY_TYPES.has(type)) continue;
    blocks = appendBlockEvent(blocks, ev as unknown as AppendBlockEvent);
  }
  return blocks;
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

/** Part 27 A4: "Progress n/m" header chip opening a completed/current/pending
 *  popover — replaces the always-inline Worker plan card with one affordance. */
function ProgressPopover({ todos }: { todos: WorkbenchTodo[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  const pending = todos.filter((t) => t.status === 'pending');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/20 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
        data-testid="subagent-progress-chip"
      >
        <ListTodo className="size-3" />
        Progress {done}/{todos.length}
        <ChevronDown className={cn('size-2.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border/60 bg-popover p-2 shadow-xl"
          data-testid="subagent-progress-popover"
        >
          {done > 0 && (
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ChevronDown className="size-3 -rotate-90" />
              {done} completed
            </div>
          )}
          {current && (
            <div className="flex items-start gap-1.5 py-0.5 text-[12px] text-foreground">
              <ArrowRight className="mt-0.5 size-3 shrink-0 text-primary/80" />
              <span className="min-w-0">{current.content}</span>
            </div>
          )}
          {pending.map((t) => (
            <div key={t.id} className="flex items-start gap-1.5 py-0.5 text-[12px] text-muted-foreground/80">
              <Circle className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
              <span className="min-w-0">{t.content}</span>
            </div>
          ))}
          {done === 0 && !current && pending.length === 0 && (
            <p className="px-1 py-0.5 text-[11px] italic text-muted-foreground/60">No steps yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Part 27 A2: the tab strip's search dropdown — open tabs with title +
 *  elapsed, filter-as-you-type, click to select. */
function TabSearchDropdown({
  tabs,
  onSelect,
}: {
  tabs: Array<{ taskId: string; label: string; elapsed?: number }>;
  onSelect: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = tabs.filter((t) =>
    !q.trim() || t.label.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Search tabs"
        className="rounded p-1 text-muted-foreground/70 transition hover:bg-white/[0.06] hover:text-foreground"
        data-testid="subagent-tab-search"
      >
        <Search className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-border/60 bg-popover p-1.5 shadow-xl">
          <div className="mb-1 flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1">
            <Search className="size-3 text-muted-foreground/60" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search tabs…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <p className="px-1.5 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Open tabs
          </p>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-[11.5px] italic text-muted-foreground/60">No matching tabs.</p>
            )}
            {filtered.map((t) => (
              <button
                key={t.taskId}
                type="button"
                onClick={() => {
                  onSelect(t.taskId);
                  setOpen(false);
                  setQ('');
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-foreground/85 transition hover:bg-white/[0.05]"
              >
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {typeof t.elapsed === 'number' && (
                  <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/55">
                    {fmtElapsed(t.elapsed)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
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

  // Part 27 A3: live elapsed ticker for the "Working for …" header. Kept at
  // the top level (hooks must not sit behind the selected-view branch).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyRunning = activeAgents.length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  /** Unified transcript entries, chronological: live first, then finished. */
  const entries: Array<{ key: string; agent: SessionAgentRow }> = useMemo(() => {
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
  }, [activeAgents, query.data?.agents, runsQuery.data, subagentBlocks]);

  const selectedAgent = selectedTaskId
    ? entries.find((e) => e.key === selectedTaskId)?.agent ?? null
    : null;
  const selectedBlock = selectedTaskId ? subagentBlocks?.get(selectedTaskId) ?? null : null;

  /** Display label per entry: the task goal, falling back to the role. When
   *  two workers share a label (e.g. two empty-goal "general" agents), append
   *  an index so tabs/rows never collapse into identical text. */
  const displayLabels = useMemo(() => {
    const base = new Map<string, string>();
    for (const e of entries) {
      base.set(e.key, e.agent.goal?.trim() || getAgentRoleLabel(e.agent.agentId) || 'Agent');
    }
    const counts = new Map<string, number>();
    for (const label of base.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
    const seen = new Map<string, number>();
    const out = new Map<string, string>();
    for (const e of entries) {
      const label = base.get(e.key) ?? 'Agent';
      if ((counts.get(label) ?? 0) > 1) {
        const n = (seen.get(label) ?? 0) + 1;
        seen.set(label, n);
        out.set(e.key, `${label} ${n}`);
      } else {
        out.set(e.key, label);
      }
    }
    return out;
  }, [entries]);

  // Part 27 A5: settled agent with no live blocks → replay the persisted
  // work transcript so the tab keeps its full Thought/Terminal/Read log.
  const settledNoLive =
    !!selectedTaskId && !selectedBlock && !!selectedAgent && !ACTIVE_STATUSES.has(selectedAgent.status);
  const replayQuery = useQuery({
    queryKey: ['subagent-transcript', selectedTaskId],
    queryFn: () => getSubagentTranscript(selectedTaskId!),
    enabled: settledNoLive,
    staleTime: 60_000,
  });
  const replayBlocks = useMemo<MessageBlock[] | null>(
    () => (replayQuery.data ? transcriptToBlocks(replayQuery.data.events) : null),
    [replayQuery.data],
  );

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
    const running = ACTIVE_STATUSES.has(selectedAgent.status);
    const startedMs = selectedBlock?.startedAt
      ? (selectedBlock.startedAt > 1e12 ? selectedBlock.startedAt : selectedBlock.startedAt * 1000)
      : undefined;
    const elapsedSec = running && startedMs
      ? (nowMs - startedMs) / 1000
      : selectedBlock?.finishedAt && startedMs
        ? (selectedBlock.finishedAt - startedMs) / 1000
        : typeof selectedAgent.elapsed === 'number'
          ? selectedAgent.elapsed
          : undefined;

    const headerLabel = running
      ? `Working for ${elapsedSec != null ? fmtElapsed(elapsedSec) : '…'}`
      : elapsedSec != null
        ? `Worked for ${fmtElapsed(elapsedSec)}`
        : statusWord(selectedAgent.status);

    const tabs = entries.map((e) => ({
      taskId: e.key,
      label: displayLabels.get(e.key) || getAgentRoleLabel(e.agent.agentId),
      elapsed: typeof e.agent.elapsed === 'number' ? e.agent.elapsed : undefined,
    }));

    return (
      <div className="flex h-full min-h-0 flex-col drawer-section-text">
        {/* Open views — task-titled tabs + search dropdown (A2) */}
        <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 px-2 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {tabs.map((t) => {
              const agent = entries.find((e) => e.key === t.taskId)?.agent;
              if (!agent) return null;
              const active = t.taskId === selectedTaskId;
              return (
                <div
                  key={t.taskId}
                  className={cn(
                    'group flex max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs',
                    active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-white/[0.05]',
                  )}
                >
                  <StatusGlyph status={agent.status} />
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId(t.taskId)}
                    className="min-w-0 truncate text-left"
                    title={t.label}
                  >
                    {t.label}
                  </button>
                  {typeof t.elapsed === 'number' && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                      {fmtElapsed(t.elapsed)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId((cur) => (cur === t.taskId ? null : cur))}
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
          <TabSearchDropdown tabs={tabs} onSelect={(id) => setSelectedTaskId(id)} />
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          data-testid={`right-drawer-subagent-view-${selectedTaskId}`}
        >
          {/* Chat-style header: who + live timer + progress chip. */}
          <div className="mb-3 flex items-center gap-2">
            <StatusGlyph status={selectedAgent.status} />
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {displayLabels.get(selectedTaskId) || getAgentRoleLabel(selectedAgent.agentId)}
            </h3>
            <span className="shrink-0 text-xs text-muted-foreground/70">{headerLabel}</span>
          </div>

          {(() => {
            const agentTodos = (selectedAgent as { todos?: WorkbenchTodo[] }).todos;
            const list = agentTodos?.length ? agentTodos : run?.todos;
            return list?.length ? <ProgressPopover todos={list} /> : null;
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
          ) : replayBlocks && replayBlocks.length > 0 ? (
            /* A5: settled + reloaded — replay the persisted work transcript. */
            <SubagentTimeline
              state={{
                id: `replay_${selectedTaskId}`,
                jobId: selectedTaskId,
                parentToolId: '',
                agentId: selectedAgent.agentId,
                task: selectedAgent.goal,
                status: selectedAgent.status === 'failed' ? 'failed' : 'completed',
                startedAt: 0,
                blocks: replayBlocks,
                error: run?.error,
              }}
              hideTaskPrompt
            />
          ) : run?.resultText ? (
            /* Settled run with no transcript on disk: the result IS the chat. */
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
                  {displayLabels.get(key) || getAgentRoleLabel(agent.agentId) || 'Agent'}
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
