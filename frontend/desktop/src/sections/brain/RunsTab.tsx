/* Runs tab — sub-agent run history, live progress, terminate, proposals.
 * Visibility-first: no launcher yet — runs originate from chat tool use. */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Check,
  Gauge,
  Network,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Loader2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageLoader } from '@/components/PageLoader';
import { api } from '@/api/client';
import * as subagents from '@/api/subagents';
import { useSessionsStore } from '@/store/sessions';

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
  createdAt?: string;
}

interface Proposal {
  proposalId: string;
  createdAt?: number;
  workItemCount?: number;
  goals?: string[];
}

const STATUS_TONES: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-400 animate-pulse',
  completed: 'bg-emerald-500/15 text-emerald-500',
  partial: 'bg-amber-500/15 text-amber-500',
  failed: 'bg-rose-500/15 text-rose-500',
  cancelled: 'bg-zinc-500/15 text-zinc-400',
};

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RunsTab() {
  const qc = useQueryClient();
  const { data, error, isFetching } = useQuery<{ runs: RunRecord[] }>({
    queryKey: ['subagent-runs'],
    queryFn: async () => api.get<{ runs: RunRecord[] }>('/api/subagents/runs?limit=100'),
    // Fast poll while anything is alive; slow otherwise (history rarely changes).
    refetchInterval: (query) => {
      const runs = (query.state.data as { runs: RunRecord[] } | undefined)?.runs ?? [];
      return runs.some((r) => r.status === 'pending' || r.status === 'running') ? 4_000 : 20_000;
    },
    staleTime: 2_000,
  });

  // ── Daemons (D11) ────────────────────────────────────────────────────
  interface DaemonRow {
    id: string;
    name: string;
    prompt?: string;
    watchCondition?: string;
    status?: string;
  }
  const { data: daemons } = useQuery<{ daemons: DaemonRow[] }>({
    queryKey: ['daemons'],
    queryFn: async () => api.get<{ daemons: DaemonRow[] }>('/api/daemons'),
    refetchInterval: 5_000,
  });
  const [daemonPrompt, setDaemonPrompt] = useState('');
  const [daemonName, setDaemonName] = useState('');
  const [daemonCondition, setDaemonCondition] = useState('');
  const spawnDaemon = useMutation({
    mutationFn: () =>
      api.post<{ daemonId: string }>('/api/daemons', {
        name: daemonName || 'watcher',
        prompt: daemonPrompt,
        watchCondition: daemonCondition,
      }),
    onSuccess: () => {
      toast.success('Daemon spawned');
      setDaemonPrompt('');
      void qc.invalidateQueries({ queryKey: ['daemons'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Spawn failed'),
  });
  const killDaemon = useMutation({
    mutationFn: (id: string) => api.post(`/api/daemons/${encodeURIComponent(id)}/kill`),
    onSuccess: () => {
      toast.success('Daemon killed');
      void qc.invalidateQueries({ queryKey: ['daemons'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Kill failed'),
  });

  // ── Sub-agent launcher (D12) ─────────────────────────────────────────
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launchGoals, setLaunchGoals] = useState('');
  const [launchAgent, setLaunchAgent] = useState('general');
  const [launchMode, setLaunchMode] = useState<'auto' | 'proposed'>('auto');
  // Bind the launch to the most recent chat session with a workbench id so
  // events stream into that transcript + the right-drawer roster (without a
  // session the agents attach to 'default' and are invisible in chat).
  const sessions = useSessionsStore((s) => s.sessions);
  const launchSessionId = useMemo(() => {
    const candidates = sessions
      .filter((s) => !s.isArchived && s.workbenchSessionId)
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return candidates[0]?.workbenchSessionId;
  }, [sessions]);
  const launchAgents = useMutation({
    mutationFn: () =>
      subagents.spawn(
        {
          workItems: launchGoals
            .split('\n')
            .map((g) => g.trim())
            .filter(Boolean)
            .map((goal) => ({ goal, agentId: launchAgent })),
          mode: launchMode,
        },
        launchSessionId,
      ),
    onSuccess: (res) => {
      toast.success(
        res.status === 'awaiting_approval' ? 'Proposal created — approve it in chat' : 'Agents launched',
      );
      setLauncherOpen(false);
      setLaunchGoals('');
      void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Launch failed'),
  });

  const { data: proposals } = useQuery<{ proposals: Proposal[] }>({
    queryKey: ['subagent-proposals'],
    queryFn: async () => api.get<{ proposals: Proposal[] }>('/api/subagents/proposals'),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['subagent-runs'] });
    void qc.invalidateQueries({ queryKey: ['subagent-proposals'] });
  };

  const terminate = useMutation({
    mutationFn: (taskId: string) => subagents.terminate(taskId),
    onSuccess: () => {
      toast.success('Sub-agent terminated');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Terminate failed'),
  });
  const resumeRun = useMutation({
    mutationFn: (taskId: string) => subagents.resume(taskId),
    onSuccess: (res) => {
      toast.success(
        `Re-launched — new task ${res.total ?? ''}${res.results?.[0]?.taskId ? ` (${res.results[0].taskId})` : ''} streaming into the original session`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Resume failed'),
  });

  const decideProposal = useMutation({
    mutationFn: ({ proposalId, approved }: { proposalId: string; approved: boolean }) =>
      subagents.proposeBreakdown(proposalId, approved),
    onSuccess: (_res, vars) => {
      toast.success(vars.approved ? 'Proposal approved — agents launched' : 'Proposal rejected');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Decision failed'),
  });

  if (error) {
    return <div className="p-4 text-danger">Error loading runs: {error.message}</div>;
  }
  if (!data) {
    return <PageLoader label="Loading agent runs…" variant="card" className="py-4" />;
  }

  const runs = data.runs ?? [];
  const pendingProposals = proposals?.proposals ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex items-center gap-1.5 text-xs md:col-span-2">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <span className="text-muted-foreground">
          {isFetching ? 'Refreshing…' : `${runs.length} runs recorded`}
        </span>
        <span className="text-[10px] text-muted-foreground/70 ml-auto">
          Runs are spawned by agents mid-chat; history persists across restarts.
        </span>
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground shrink-0"
          data-testid="launch-agents"
        >
          <Rocket className="size-3" />
          Launch agents
        </button>
      </div>

      {/* Pending proposals */}
      {pendingProposals.length > 0 ? (
        <Card className="p-4 space-y-2 md:col-span-2 border-primary/40 bg-primary/[0.03]">
          <div className="flex items-center gap-2">
            <Play className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Pending breakdown proposals</h3>
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
              {pendingProposals.length} awaiting your decision
            </span>
          </div>
          <ul className="space-y-2">
            {pendingProposals.map((p) => (
              <li key={p.proposalId} className="text-xs p-2 rounded border border-border space-y-1">
                <p className="text-muted-foreground">
                  {p.workItemCount ?? 0} agent(s) proposed for parallel work:
                </p>
                {(p.goals ?? []).map((g, i) => (
                  <p key={i} className="pl-3 text-muted-foreground/80">
                    • {g}
                  </p>
                ))}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded bg-success/20 text-success disabled:opacity-50"
                    disabled={decideProposal.isPending}
                    data-testid={`approve-proposal-${p.proposalId}`}
                    onClick={() => decideProposal.mutate({ proposalId: p.proposalId, approved: true })}
                  >
                    <Check className="size-3 inline mr-1" />
                    Launch
                  </button>
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground disabled:opacity-50"
                    disabled={decideProposal.isPending}
                    data-testid={`reject-proposal-${p.proposalId}`}
                    onClick={() => decideProposal.mutate({ proposalId: p.proposalId, approved: false })}
                  >
                    <X className="size-3 inline mr-1" />
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Run history */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Run history</h3>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {runs.length}
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No sub-agent runs yet — they appear when an agent spawns helpers mid-conversation.
          </p>
        ) : (
          <ul className="space-y-2 max-h-[28rem] overflow-y-auto">
            {runs.map((r) => (
              <li key={r.id} className="text-xs p-2.5 rounded border border-border space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_TONES[r.status ?? ''] ?? 'bg-muted text-muted-foreground'}`}
                    data-testid={`run-status-${r.taskId}`}
                  >
                    {r.status ?? 'unknown'}
                  </span>
                  <span className="font-medium">{r.agentId || 'general'}</span>
                  <span className="text-muted-foreground font-mono text-[10px]">{r.taskId}</span>
                  {r.sessionId ? (
                    <span className="text-[10px] text-muted-foreground font-mono" title="Source session">
                      session {r.sessionId.slice(0, 12)}…
                    </span>
                  ) : null}
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                    {formatTime(r.startedAt)}
                    {r.finishedAt ? ` → ${formatTime(r.finishedAt)}` : ''}
                  </span>
                  {r.status === 'pending' || r.status === 'running' ? (
                    <button
                      type="button"
                      title="Terminate"
                      className="p-1 text-muted-foreground hover:text-danger"
                      data-testid={`terminate-run-${r.taskId}`}
                      onClick={() => terminate.mutate(r.taskId ?? '')}
                    >
                      <Square className="size-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Re-run this sub-agent (same goal + agent, original session)"
                      className="p-1 text-muted-foreground hover:text-primary disabled:opacity-40"
                      data-testid={`resume-run-${r.taskId}`}
                      disabled={resumeRun.isPending || !r.goal}
                      onClick={() => resumeRun.mutate(r.taskId ?? '')}
                    >
                      {resumeRun.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                    </button>
                  )}
                </div>
                {r.goal ? <p className="text-muted-foreground">{r.goal}</p> : null}
                {r.resultSummary ? (
                  <p className="text-muted-foreground/80 line-clamp-3 whitespace-pre-wrap">{r.resultSummary}</p>
                ) : null}
                {r.error ? (
                  <p className="text-danger/90 line-clamp-2 whitespace-pre-wrap">{r.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Daemons (D11) */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Subconscious daemons</h3>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {(daemons?.daemons ?? []).length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={daemonName}
            onChange={(e) => setDaemonName(e.target.value)}
            className="w-28 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
            placeholder="name"
            aria-label="Daemon name"
          />
          <input
            value={daemonPrompt}
            onChange={(e) => setDaemonPrompt(e.target.value)}
            className="flex-1 min-w-40 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
            placeholder="Prompt — what should the daemon watch and report?"
            aria-label="Daemon prompt"
          />
          <input
            value={daemonCondition}
            onChange={(e) => setDaemonCondition(e.target.value)}
            className="w-40 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px]"
            placeholder="watchCondition (optional)"
            aria-label="Daemon watch condition"
          />
          <button
            type="button"
            disabled={spawnDaemon.isPending || !daemonPrompt.trim()}
            onClick={() => spawnDaemon.mutate()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
            data-testid="spawn-daemon"
          >
            <Plus className="size-3" />
            Spawn
          </button>
        </div>
        {(daemons?.daemons ?? []).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No daemons running — spawn one above (e.g. prompt "watch for TODO comments",
            condition "on_change") and its reports land in the chat as subconscious updates.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {daemons!.daemons.map((d) => (
              <li key={d.id} className="text-xs flex items-start gap-2 p-2 rounded border border-border">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {d.name}
                    <span
                      className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full ${
                        d.status === 'running' || d.status === 'idle'
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {d.status ?? 'registered'}
                    </span>
                  </p>
                  <p className="text-muted-foreground line-clamp-2">{d.prompt}</p>
                  {d.watchCondition ? (
                    <p className="text-[10px] text-muted-foreground font-mono">{d.watchCondition}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => killDaemon.mutate(d.id)}
                  className="p-1 rounded text-muted-foreground hover:text-danger"
                  title="Kill daemon"
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Sub-agent launcher modal (D12) */}
      {launcherOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Launch sub-agents"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLauncherOpen(false);
          }}
          data-testid="launcher-modal"
        >
          <div className="w-full max-w-lg rounded-xl border border-border bg-popover p-4 shadow-xl space-y-3">
            <div className="flex items-center gap-2">
              <Rocket className="size-4 text-primary" />
              <h3 className="font-medium text-sm">Launch sub-agents</h3>
              <button
                type="button"
                onClick={() => setLauncherOpen(false)}
                className="ml-auto p-1 text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <textarea
              value={launchGoals}
              onChange={(e) => setLaunchGoals(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs resize-none"
              placeholder="One goal per line — each becomes a parallel sub-agent"
              aria-label="Agent goals"
              data-testid="launcher-goals"
            />
            <div className="flex items-center gap-2 text-xs">
              <label className="text-muted-foreground">Agent</label>
              <input
                value={launchAgent}
                onChange={(e) => setLaunchAgent(e.target.value)}
                className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                placeholder="general"
              />
              <label className="text-muted-foreground">Mode</label>
              <select
                value={launchMode}
                onChange={(e) => setLaunchMode(e.target.value as 'auto' | 'proposed')}
                className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
              >
                <option value="auto">auto</option>
                <option value="proposed">proposed</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLauncherOpen(false)}
                className="text-xs px-3 py-1.5 rounded bg-muted text-muted-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={launchAgents.isPending || launchGoals.trim().split('\n').filter(Boolean).length === 0}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
                data-testid="launcher-go"
                onClick={() => launchAgents.mutate()}
              >
                <Play className="size-3 inline mr-1" />
                Launch {launchGoals.trim().split('\n').filter(Boolean).length} agent
                {launchGoals.trim().split('\n').filter(Boolean).length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
