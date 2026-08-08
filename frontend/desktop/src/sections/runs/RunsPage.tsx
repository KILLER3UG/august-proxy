/* ── Runs — workbench session runs as a tracker ─────────────────────── */
/* Status, model, tokens, cost, and duration for every workbench run,
 * with one-click jump back into the chat. Fed by GET /api/workbench/sessions
 * (backend `summarize_session`); polls fast while anything is active. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Clock,
  Coins,
  ExternalLink,
  History,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
} from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import {
  startChatStream,
  stopChatStream,
  getOrInitSessionStreamState,
  resolveUiSessionId,
} from '@/sections/chat/chat-stream-manager';
import { getWorkbenchSession } from '@/api/workbench';
import { normalizeWorkbenchSession } from '@/lib/workbench-plan';
import type { ChatMessage } from '@/types/chat';

interface WorkbenchRun {
  id: string;
  title: string;
  provider: string;
  model: string;
  agentId: string;
  goal?: string;
  messageCount: number;
  mutationCount: number;
  turnCount: number;
  status: string; // 'idle' | 'streaming' | 'awaiting_approval'
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  workspacePath?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

type Filter = 'all' | 'working' | 'awaiting' | 'completed';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working' },
  { id: 'awaiting', label: 'Awaiting approval' },
  { id: 'completed', label: 'Completed' },
];

/** Presentational status: live status → tone + label + completed flag. */
function runPhase(run: WorkbenchRun): {
  label: string;
  tone: string;
  live: boolean;
  done: boolean;
} {
  if (run.status === 'streaming') {
    return { label: 'Working', tone: 'bg-sky-500/15 text-sky-400 animate-pulse', live: true, done: false };
  }
  if (run.status === 'awaiting_approval') {
    return { label: 'Awaiting approval', tone: 'bg-amber-500/15 text-amber-500', live: true, done: false };
  }
  if (run.messageCount > 0 || run.turnCount > 0) {
    return { label: 'Completed', tone: 'bg-emerald-500/15 text-emerald-500', live: false, done: true };
  }
  return { label: 'Empty', tone: 'bg-zinc-500/15 text-zinc-400', live: false, done: true };
}

function fmtDurationMs(ms: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtTokens(n?: number): string {
  const v = Number(n ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtCost(c?: number): string {
  const v = Number(c ?? 0);
  if (v <= 0) return '—';
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-3.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function RunsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { data, isFetching } = useQuery<WorkbenchRun[]>({
    queryKey: ['workbench-runs'],
    queryFn: async () => api.get<WorkbenchRun[]>('/api/workbench/sessions'),
    // Fast poll while anything is live; slow otherwise (history rarely changes).
    refetchInterval: (query) => {
      const runs = query.state.data ?? [];
      return runs.some((r) => r.status === 'streaming' || r.status === 'awaiting_approval')
        ? 4_000
        : 20_000;
    },
    staleTime: 2_000,
  });

  /** Re-send the run's last user message as a fresh turn (same session,
   *  same model — the backend appends the message like a normal send). */
  const retryRun = async (run: WorkbenchRun) => {
    const uiId = resolveUiSessionId(run.id);
    const msgs = getOrInitSessionStreamState(uiId).messages ?? [];
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
    let content = '';
    let chatHistory: ChatMessage[] | undefined;
    if (lastUserIdx !== -1) {
      const lastUser = msgs[lastUserIdx];
      content = typeof lastUser.content === 'string' ? lastUser.content : '';
      // Replay prefix WITHOUT the last user message — the backend appends it.
      chatHistory = msgs.slice(0, lastUserIdx);
    }
    if (!content) {
      // Fallback: pull the workbench session's own transcript.
      try {
        const full = await getWorkbenchSession(run.id);
        const wbMsgs = (full as unknown as { messages?: Array<{ role?: string; content?: unknown }> })
          .messages ?? [];
        const wbUser = [...wbMsgs].reverse().find((m) => m.role === 'user');
        content = typeof wbUser?.content === 'string' ? wbUser.content : '';
      } catch {
        /* ignore */
      }
    }
    if (!content) {
      toast.error('No user message to retry');
      return;
    }
    setRetryingId(run.id);
    try {
      const loaded = await getWorkbenchSession(run.id).catch(() => null);
      const session = normalizeWorkbenchSession(loaded) ?? loaded;
      const result = await startChatStream(uiId, {
        message: content,
        chatHistory: chatHistory ?? [],
        workbenchMode: 'full',
        effort: 'medium',
        thinkingEnabled: true,
        model: run.model || undefined,
        modelProvider: run.provider || undefined,
        provider: run.provider || undefined,
        ensureWorkbenchSession: async () => session,
      });
      if (result === 'error') {
        toast.error('Retry failed — check the backend');
      } else {
        toast.success('Retrying last message');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  /** Abort the run's active stream (if any). */
  const cancelRun = (run: WorkbenchRun) => {
    const uiId = resolveUiSessionId(run.id);
    stopChatStream(uiId);
    toast.success('Run stopped');
  };

  const runs = useMemo(() => data ?? [], [data]);

  const stats = useMemo(() => {
    const active = runs.filter((r) => r.status === 'streaming').length;
    const awaiting = runs.filter((r) => r.status === 'awaiting_approval').length;
    const done = runs.filter((r) => runPhase(r).done).length;
    const tokens = runs.reduce((sum, r) => sum + (r.totalInputTokens ?? 0) + (r.totalOutputTokens ?? 0), 0);
    const cost = runs.reduce((sum, r) => sum + Number(r.totalCost ?? 0), 0);
    return { total: runs.length, active, awaiting, done, tokens, cost };
  }, [runs]);

  const visible = useMemo(
    () =>
      runs.filter((r) => {
        const phase = runPhase(r);
        if (filter === 'working') return phase.live && !phase.done;
        if (filter === 'awaiting') return r.status === 'awaiting_approval';
        if (filter === 'completed') return phase.done;
        return true;
      }),
    [runs, filter],
  );

  return (
    <div
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-6xl mx-auto space-y-6"
      data-testid="runs-page"
    >
      <div className="flex items-center gap-3">
        <History className="size-7 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">Runs</h1>
          <p className="text-sm text-muted-foreground">
            Workbench sessions — status, tokens, cost, and jump-back-into-chat
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground shrink-0"
          data-testid="runs-new"
        >
          <Plus className="size-3.5" />
          New run
        </button>
      </div>

      {/* Stat strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total runs" value={String(stats.total)} hint="Across all workspaces" />
        <StatCard
          label="Active now"
          value={String(stats.active + stats.awaiting)}
          hint={`${stats.active} working · ${stats.awaiting} awaiting approval`}
        />
        <StatCard label="Completed" value={String(stats.done)} />
        <StatCard label="Tokens · cost" value={`${fmtTokens(stats.tokens)} · ${fmtCost(stats.cost)}`} />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-[11px] transition-colors ${
              filter === f.id
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'bg-muted/40 text-muted-foreground border border-transparent hover:text-foreground'
            }`}
            data-testid={`runs-filter-${f.id}`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <RefreshCw className={`size-3 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing…' : 'Live'}
        </span>
      </div>

      {/* Run list */}
      {!data ? (
        <PageLoader label="Loading runs…" variant="card" className="py-8" />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-8 text-center">
          <History className="mx-auto size-6 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            {runs.length === 0
              ? 'No runs yet — start a chat and workbench runs appear here.'
              : 'No runs match this filter.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((run) => {
            const phase = runPhase(run);
            const start = run.startedAt || run.createdAt;
            const durationMs =
              new Date(run.updatedAt || start).getTime() - new Date(start).getTime();
            return (
              <li
                key={run.id}
                className="rounded-xl border border-white/[0.06] bg-card/60 p-3.5 flex flex-wrap items-center gap-x-4 gap-y-2"
                data-testid={`run-row-${run.id}`}
              >
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${phase.tone}`}
                  data-testid={`run-status-${run.id}`}
                >
                  {phase.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {run.title || 'Untitled run'}
                    {run.model ? (
                      <span className="ml-2 text-[10px] text-muted-foreground font-mono">
                        {run.model}
                        {run.provider ? ` @ ${run.provider}` : ''}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 truncate">
                    {run.goal || run.workspacePath || `${run.messageCount} messages · ${run.turnCount} turns`}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground shrink-0">
                  <span className="inline-flex items-center gap-1" title="Messages / turns">
                    <MessageSquare className="size-3" />
                    {run.messageCount} / {run.turnCount}
                  </span>
                  <span className="inline-flex items-center gap-1" title="Tokens">
                    <Coins className="size-3" />
                    {fmtTokens(run.totalInputTokens + run.totalOutputTokens)}
                  </span>
                  <span className="inline-flex items-center gap-1" title="Cost">
                    {fmtCost(run.totalCost)}
                  </span>
                  <span className="inline-flex items-center gap-1" title="Duration">
                    <Clock className="size-3" />
                    {fmtDurationMs(durationMs)}
                  </span>
                  <span title="Last updated">{fmtTime(run.updatedAt)}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {phase.live ? (
                    <button
                      type="button"
                      onClick={() => cancelRun(run)}
                      className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-rose-500/15 hover:text-rose-400"
                      title="Stop the active stream"
                      data-testid={`run-cancel-${run.id}`}
                    >
                      <Square className="size-3" />
                      Cancel
                    </button>
                  ) : run.messageCount > 0 ? (
                    <button
                      type="button"
                      disabled={retryingId === run.id}
                      onClick={() => void retryRun(run)}
                      className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
                      title="Re-send the last user message"
                      data-testid={`run-retry-${run.id}`}
                    >
                      <RotateCcw className={`size-3 ${retryingId === run.id ? 'animate-spin' : ''}`} />
                      {retryingId === run.id ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => navigate(`/c/${resolveUiSessionId(run.id)}`)}
                    className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-foreground hover:bg-muted"
                    data-testid={`run-open-${run.id}`}
                  >
                    <ExternalLink className="size-3" />
                    Open
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
