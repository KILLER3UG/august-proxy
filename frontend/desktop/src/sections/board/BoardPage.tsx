/* ── Agent Board — multi-agent work surface (/board) ─────────────────── */
/* The roadmap's "board is a work surface, not a setting": the durable
 * kanban board now lives at /board, with a team launcher that spawns one
 * sub-agent per goal, auto-creates a card per goal, and live-syncs card
 * columns to run status (running → doing, completed → done, failed →
 * backlog). The board itself stays in localStorage (KanbanSection).
 *
 * Density note: the board page used to stack its own "Agent Board" header
 * on top of the board component's own "Agent board" header, and the team
 * launcher sat open on every visit. There is now ONE header (the board
 * component's is switched off here) and the launcher is a disclosure. */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Kanban, Loader2, Rocket, Square, X } from 'lucide-react';
import { KanbanSection } from '@/sections/settings/KanbanSection';
import { useKanbanStore, type KanbanCard } from '@/store/kanban-board';
import { useSessionsStore } from '@/store/sessions';
import { api } from '@/api/client';
import { spawn, terminate } from '@/api/subagents';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/PageLoader';
import { QueryErrorState } from '@/components/QueryErrorState';

interface RunRecord {
  id: number;
  taskId?: string;
  sessionId?: string;
  agentId?: string;
  goal?: string;
  status?: string;
  resultSummary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

const RUN_TONES: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-info/15 text-info',
  completed: 'bg-success/15 text-success-fg',
  partial: 'bg-warning/15 text-warning-fg',
  failed: 'bg-danger/15 text-danger-fg',
  cancelled: 'bg-muted text-muted-foreground',
};

export function BoardPage() {
  const qc = useQueryClient();
  const [goals, setGoals] = useState('');
  const [agentId, setAgentId] = useState('general');
  const [launching, setLaunching] = useState(false);
  // The launcher is a disclosure: a board visit is a look at the board, not
  // a form to fill in.
  const [launcherOpen, setLauncherOpen] = useState(false);

  const {
    data: runs,
    isLoading: runsLoading,
    isError: runsFailed,
    error: runsError,
    refetch: refetchRuns,
    isRefetching: runsRefetching,
  } = useQuery<{ runs: RunRecord[] }>({
    queryKey: ['subagent-runs'],
    queryFn: () => api.get<{ runs: RunRecord[] }>('/api/subagents/runs?limit=50'),
    refetchInterval: (query) => {
      const list = (query.state.data)?.runs ?? [];
      return list.some((r) => r.status === 'pending' || r.status === 'running') ? 3_000 : 15_000;
    },
    staleTime: 2_000,
  });

  // Live card sync: link cards to runs by taskId (or goal text for cards
  // created before the run's taskId was known) and advance columns.
  useEffect(() => {
    const list = runs?.runs ?? [];
    if (list.length === 0) return;
    const store = useKanbanStore.getState();
    const cards = store.cards;
    let changed = false;
    for (const run of list) {
      const taskId = run.taskId ?? '';
      if (!taskId) continue;
      const byTask = cards.find((c) => c.taskId === taskId);
      const card: KanbanCard | undefined =
        byTask ?? cards.find((c) => !c.taskId && c.title === (run.goal ?? ''));
      if (!card) continue;
      if (!card.taskId && taskId) {
        store.updateCard(card.id, { taskId });
        changed = true;
      }
      const target =
        run.status === 'completed'
          ? 'done'
          : run.status === 'failed'
            ? 'backlog'
            : run.status === 'running'
              ? 'doing'
              : card.column;
      if (target !== card.column) {
        store.moveCard(card.id, target);
        changed = true;
      }
    }
    if (changed) qc.invalidateQueries({ queryKey: ['subagent-runs'] }).catch(() => undefined);
  }, [runs, qc]);

  const launch = async () => {
    const items = goals
      .split('\n')
      .map((g) => g.trim())
      .filter(Boolean);
    if (items.length === 0) return;
    setLaunching(true);
    try {
      // Bind to the most recent chat session (see RunsTab) so launched
      // agents stream into that transcript instead of 'default'.
      const sessions = useSessionsStore.getState().sessions;
      const sessionId = sessions
        .filter((s) => !s.isArchived && s.workbenchSessionId)
        .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0]
        ?.workbenchSessionId;
      const res = await spawn(
        {
          workItems: items.map((goal) => ({ goal, agentId })),
          mode: 'auto',
        },
        sessionId,
      );
      // One board card per launched agent (even proposed breakdowns get a
      // card — the run-sync moves it once execution starts).
      const store = useKanbanStore.getState();
      items.forEach((goal) => {
        store.addCard(goal, 'backlog', { agentId });
      });
      setGoals('');
      toast.success(
        res.status === 'awaiting_approval'
          ? 'Team proposal created — approve it in chat to launch'
          : `Team launched — ${items.length} agent${items.length === 1 ? '' : 's'} working in parallel`,
      );
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Launch failed');
    } finally {
      setLaunching(false);
    }
  };

  const kill = async (taskId: string) => {
    try {
      await terminate(taskId);
      toast.success('Agent terminated');
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Terminate failed');
    }
  };

  const active = (runs?.runs ?? []).filter(
    (r) => r.status === 'pending' || r.status === 'running',
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-6xl mx-auto space-y-5" data-testid="board-page">
      <div className="flex flex-wrap items-center gap-3">
        <Kanban className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {/* h2, not h1: the titlebar already renders this route's single h1.
              This is the page's ONLY header — the board component's own
              header is switched off below. */}
          <h2 className="text-2xl font-semibold">Agent board</h2>
          <p className="text-sm text-muted-foreground">
            Launch a team and track every agent on one board
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setLauncherOpen((v) => !v)}
          aria-expanded={launcherOpen}
          aria-controls="board-team-launcher"
          data-testid="board-launch-toggle"
        >
          <Rocket className="size-3" />
          Launch a team
        </Button>
      </div>

      {/* Team launcher — behind the disclosure above. */}
      {launcherOpen && (
        <div
          id="board-team-launcher"
          className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-3"
        >
          <div className="flex items-center gap-2">
            <Rocket className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">Launch a team</h3>
            <span className="text-2xs text-muted-foreground/60 ml-auto">
              one agent per goal line — runs in parallel, cards advance as they finish
            </span>
          </div>
          <textarea
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs resize-none"
            placeholder={'One goal per line, e.g.\nAudit the backend for unhandled exceptions\nWrite tests for the privacy router'}
            aria-label="Team goals"
            data-testid="board-goals"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground shrink-0">Agent</label>
            <input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-32 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              aria-label="Agent id"
              data-testid="board-agent"
            />
            <Button
              disabled={launching || goals.trim().split('\n').filter((g) => g.trim()).length === 0}
              onClick={() => void launch()}
              data-testid="board-launch"
            >
              {launching ? <Loader2 className="size-3 animate-spin" /> : <Rocket className="size-3" />}
              Launch {goals.trim().split('\n').filter((g) => g.trim()).length || ''} agent
              {goals.trim().split('\n').filter((g) => g.trim()).length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}

      {/* Active agents strip. The run list is the only thing here that comes
          from the network, so it is the only thing that needs a loading and
          a failure state — the board below renders from local storage and
          must not be replaced by a skeleton. */}
      {runsLoading ? (
        <PageLoader label="Loading agent runs…" className="py-4" />
      ) : runsFailed ? (
        <QueryErrorState
          error={runsError}
          onRetry={() => void refetchRuns()}
          retrying={runsRefetching}
          title="Couldn't load agent runs"
          note="The board below is still live — only the run list is missing."
        />
      ) : active.length > 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">Working now</h3>
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs text-primary">{active.length}</span>
          </div>
          <ul className="space-y-1.5">
            {active.map((r) => (
              <li key={r.taskId ?? r.id} className="flex items-center gap-2 text-xs py-1">
                <span className={`text-2xs px-2 py-0.5 rounded-full ${RUN_TONES[r.status ?? ''] ?? 'bg-muted text-muted-foreground'}`}>
                  {r.status}
                </span>
                <span className="font-medium truncate">{r.goal || r.agentId || 'agent'}</span>
                <span className="text-muted-foreground/60 font-mono text-2xs">{r.agentId}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => r.taskId && void kill(r.taskId)}
                  title="Terminate"
                  aria-label="Terminate agent"
                  className="ml-auto size-6 text-muted-foreground hover:text-danger"
                  data-testid={`board-kill-${r.taskId}`}
                >
                  <Square className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The board itself — its own header is off, this page owns the title. */}
      <KanbanSection showHeader={false} />

      {!runsLoading && !runsFailed && (runs?.runs ?? []).length === 0 ? (
        <p className="text-2xs text-muted-foreground/60 flex items-center gap-1.5">
          <X className="size-3" />
          No agent runs yet — spawn one from the composer, from chat tool use, or launch a team above.
        </p>
      ) : null}
    </div>
  );
}
