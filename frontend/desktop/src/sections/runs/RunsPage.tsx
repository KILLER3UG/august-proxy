/* ── Runs — workbench session runs as a tracker ─────────────────────── */
/* Status, model, tokens, cost, and duration for every workbench run,
 * with one-click jump back into the chat. Fed by GET /api/workbench/sessions
 * (backend `summarize_session`); polls fast while anything is active.
 *
 * Density note: this page was the one page-local outlier — four stat CARDS
 * across the top, a filled status PILL per row, a five-item stat cluster
 * with three icons on every row, and a per-row bordered card. It now reads
 * like the reference's list views instead: one muted line of totals, a
 * borderless hairline-separated row, a status DOT instead of a pill, one
 * muted mono meta line, and one always-reachable action. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronRight,
  ExternalLink,
  History,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
} from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

/** The three status groups the list is organised into. `open` is the initial
 *  disclosure state: the two groups that need attention start open, the
 *  backlog of finished runs does not. */
const GROUPS: readonly { id: Exclude<Filter, 'all'>; label: string; open: boolean }[] = [
  { id: 'working', label: 'Working', open: true },
  { id: 'awaiting', label: 'Awaiting approval', open: true },
  { id: 'completed', label: 'Completed', open: false },
];

/** Presentational status: live status → dot + label + completed flag. */
function runPhase(run: WorkbenchRun): {
  label: string;
  dot: string;
  live: boolean;
  done: boolean;
} {
  if (run.status === 'streaming') {
    return { label: 'Working', dot: 'bg-info animate-pulse', live: true, done: false };
  }
  if (run.status === 'awaiting_approval') {
    return { label: 'Awaiting approval', dot: 'bg-warning', live: true, done: false };
  }
  if (run.messageCount > 0 || run.turnCount > 0) {
    return { label: 'Completed', dot: 'bg-success', live: false, done: true };
  }
  return { label: 'Empty', dot: 'bg-muted-foreground/40', live: false, done: true };
}

/** Which group a run belongs to. */
function runGroup(run: WorkbenchRun): Exclude<Filter, 'all'> {
  if (run.status === 'awaiting_approval') return 'awaiting';
  if (run.status === 'streaming') return 'working';
  return 'completed';
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

export function RunsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { data, isFetching, isError, error, refetch, isRefetching } = useQuery<WorkbenchRun[]>({
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

  // A failed sessions request is not "0 runs, 0 tokens" — it used to render
  // the empty card plus a stat strip of zeroes that read like real numbers.
  // Only an answered list is allowed to say "No runs yet".
  const listFailed = isError && !data;

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
    void stopChatStream(uiId);
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

  /** The visible runs, grouped by status. Empty groups are dropped — a
   *  "Completed (0)" heading is chrome the user did not ask for. */
  const groups = useMemo(() => {
    const buckets = new Map<string, WorkbenchRun[]>();
    for (const g of GROUPS) buckets.set(g.id, []);
    for (const run of visible) buckets.get(runGroup(run))!.push(run);
    return GROUPS.map((g) => ({
      ...g,
      runs: buckets.get(g.id)!,
      // A narrowed filter is an explicit request for that group, so it opens.
      open: filter === 'all' ? g.open : true,
    })).filter((g) => g.runs.length > 0);
  }, [visible, filter]);

  return (
    <div
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-6xl mx-auto space-y-5"
      data-testid="runs-page"
    >
      <div className="flex items-center gap-3">
        <History className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {/* h2, not h1: the titlebar already renders this route's single h1. */}
          <h2 className="text-2xl font-semibold">Runs</h2>
          <p className="text-sm text-muted-foreground">
            Status, tokens, cost, and a way back into the chat
          </p>
        </div>
        <Button onClick={() => navigate('/')} data-testid="runs-new">
          <Plus className="size-3" />
          New run
        </Button>
      </div>

      {/* Totals — one muted line. Four stat CARDS used to sit here, which is
          the "N bordered boxes" shape the reference's list views do not use. */}
      {!listFailed && (
        <p className="text-2xs text-muted-foreground" data-testid="runs-stat">
          {stats.total} runs · {stats.active + stats.awaiting} active · {stats.done} done ·{' '}
          {fmtTokens(stats.tokens)} tokens · {fmtCost(stats.cost)}
        </p>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1 text-2xs transition-colors ${
              filter === f.id
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'bg-muted/40 text-muted-foreground border border-transparent hover:text-foreground'
            }`}
            data-testid={`runs-filter-${f.id}`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-2xs text-muted-foreground/70">
          <RefreshCw className={`size-3 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing…' : 'Live'}
        </span>
      </div>

      {/* Run list */}
      {listFailed ? (
        <QueryErrorState
          error={error}
          onRetry={() => void refetch()}
          retrying={isRefetching}
          title="Couldn't load runs"
          note="Your runs may still exist — the request failed, so this is not an empty history."
        />
      ) : !data ? (
        <PageLoader label="Loading runs…" variant="card" className="py-8" />
      ) : visible.length === 0 ? (
        <div className="p-8 text-center">
          <History className="mx-auto size-6 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            {runs.length === 0
              ? 'No runs yet — start a chat and workbench runs appear here.'
              : 'No runs match this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            /* A native <details> is the disclosure: no state machinery, and
               it is keyboard-reachable and screen-reader-labelled for free. */
            <details key={group.id} open={group.open} className="group/details">
              <summary
                className="flex cursor-pointer list-none items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
                data-testid={`runs-group-${group.id}`}
              >
                <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
                {group.label} · {group.runs.length}
              </summary>
              <ul className="mt-1 divide-y divide-border/60">
                {group.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    retrying={retryingId === run.id}
                    onCancel={() => cancelRun(run)}
                    onRetry={() => void retryRun(run)}
                    onOpen={() => navigate(`/c/${resolveUiSessionId(run.id)}`)}
                  />
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/** One run. Borderless, hairline-separated, hover-filled — the reference's
 *  list row. The row carries a status DOT, the title, one muted summary
 *  line, ONE muted mono meta line, and one always-reachable action; the
 *  destructive-ish extras (Cancel / Retry) are revealed on hover or focus
 *  so they are still reachable from the keyboard. */
function RunRow({
  run,
  retrying,
  onCancel,
  onRetry,
  onOpen,
}: {
  run: WorkbenchRun;
  retrying: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onOpen: () => void;
}) {
  const phase = runPhase(run);
  const start = run.startedAt || run.createdAt;
  const durationMs = new Date(run.updatedAt || start).getTime() - new Date(start).getTime();
  const summary = run.goal || run.workspacePath || `${run.messageCount} messages · ${run.turnCount} turns`;

  return (
    <li
      className="group flex items-center gap-3 px-2 py-2 transition-colors hover:bg-muted/40"
      data-testid={`run-row-${run.id}`}
    >
      <span
        className="flex w-32 shrink-0 items-center gap-1.5 text-2xs text-muted-foreground"
        data-testid={`run-status-${run.id}`}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', phase.dot)} aria-hidden />
        {phase.label}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {run.title || 'Untitled run'}
          {run.model ? (
            <span className="ml-2 font-mono text-2xs text-muted-foreground">
              {run.model}
              {run.provider ? ` @ ${run.provider}` : ''}
            </span>
          ) : null}
        </p>
        <p className="truncate text-2xs text-muted-foreground/80">{summary}</p>
      </div>

      {/* One muted meta line: tokens · cost · duration. The old row carried a
          five-item cluster with three icons; the icons were decoration. */}
      <span
        className="hidden shrink-0 font-mono text-2xs text-muted-foreground sm:inline"
        title={`Last updated ${fmtTime(run.updatedAt)}`}
      >
        {fmtTokens(run.totalInputTokens + run.totalOutputTokens)} · {fmtCost(run.totalCost)} ·{' '}
        {fmtDurationMs(durationMs)}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        {phase.live ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            title="Stop the active stream"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-danger-fg"
            data-testid={`run-cancel-${run.id}`}
          >
            <Square className="size-3" />
            Cancel
          </Button>
        ) : run.messageCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={retrying}
            onClick={onRetry}
            title="Re-send the last user message"
            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            data-testid={`run-retry-${run.id}`}
          >
            <RotateCcw className={cn('size-3', retrying && 'animate-spin')} />
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={onOpen}
          title="Open this run in the chat"
          data-testid={`run-open-${run.id}`}
        >
          <ExternalLink className="size-3" />
          Open
        </Button>
      </div>
    </li>
  );
}
