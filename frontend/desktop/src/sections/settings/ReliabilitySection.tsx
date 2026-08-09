/* ── Reliability — fleet health from routing evidence + harness evals ── */
/* Win rates, latency, token cost, and eval pass rates over the last N
 * days. Fed by /api/brain/harness/trends (routing_evidence table) and
 * /api/brain/harness/evals (loop-level golden tasks). Empty states teach
 * the data source instead of showing dead charts. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartPulse, TrendingUp, FlaskConical, Timer, Trophy, AlertTriangle, Play, Route, ArrowRight } from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { toast } from 'sonner';

interface TrendDay {
  day: string;
  model: string;
  provider: string;
  wins: number;
  total: number;
  winRate: number;
  avgTokens: number;
  avgDurationMs: number;
}

interface TrendsData {
  rangeDays: number;
  daily: TrendDay[];
}

interface EvalRun {
  taskId: string;
  model?: string;
  passed?: boolean;
  rounds?: number;
  durationMs?: number;
  notes?: string;
  at?: number;
}

interface EvalsData {
  runs: EvalRun[];
  total: number;
  passed: number;
  passRate: number | null;
}

interface BrainConfig {
  autoRoute?: boolean;
  autoRouteMinSamples?: number;
  autoRouteMinWinRate?: number;
  autoRouteWinGap?: number;
}

interface BestByTaskRow {
  taskType: string;
  model: string;
  provider: string;
  winRate: number;
  total: number;
  avgTokens: number;
  avgDurationMs: number;
}

interface RouteDecision {
  at: number;
  taskType: string;
  fromModel: string;
  fromProvider: string;
  toModel: string;
  toProvider: string;
  winRate: number;
  gap: number;
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtTime(epochSec?: number): string {
  if (!epochSec) return '—';
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDurationMs(ms?: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function StatCard({ label, value, hint, icon: Icon }: {
  label: string; value: string; hint?: string; icon: typeof Timer;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function ReliabilitySection() {
  const qc = useQueryClient();
  const [evalsRunning, setEvalsRunning] = useState(false);
  const { data: trends, isFetching: trendsFetching } = useQuery<TrendsData>({
    queryKey: ['harness-trends', 30],
    queryFn: async () => api.get<TrendsData>('/api/brain/harness/trends?days=30'),
    staleTime: 15_000,
  });
  const { data: evals, isFetching: evalsFetching } = useQuery<EvalsData>({
    queryKey: ['harness-evals', 25],
    queryFn: async () => api.get<EvalsData>('/api/brain/harness/evals?limit=25'),
    staleTime: 15_000,
  });

  const runEvals = useMutation({
    mutationFn: async () => {
      setEvalsRunning(true);
      try {
        return await api.post<{ started: boolean; note?: string }>('/api/brain/harness/evals/run');
      } finally {
        // The suite runs in the background — poll for fresh results.
        setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ['harness-evals'] });
          setEvalsRunning(false);
        }, 8_000);
      }
    },
  });

  // Pass-rate trend: bucket eval runs by day so harness changes are
  // measurable over the scheduled 6h loop (bars = pass share per day).
  const evalTrend = useMemo(() => {
    const byDay = new Map<string, { passed: number; total: number }>();
    for (const r of evals?.runs ?? []) {
      const day = r.at ? new Date(r.at * 1000).toISOString().slice(0, 10) : '?';
      const e = byDay.get(day) ?? { passed: 0, total: 0 };
      e.total += 1;
      if (r.passed) e.passed += 1;
      byDay.set(day, e);
    }
    return [...byDay.entries()].map(([day, v]) => ({ day, ...v }));
  }, [evals]);

  // ── Auto-routing (surpass #1 closed loop) ───────────────────────────
  const { data: brainConfig } = useQuery<{ config: BrainConfig }>({
    queryKey: ['brain-config'],
    queryFn: () => api.get<{ config: BrainConfig }>('/api/brain/config'),
    staleTime: 15_000,
  });
  const { data: bestByTask } = useQuery<{ results: BestByTaskRow[] }>({
    queryKey: ['routing-best-by-task'],
    queryFn: () => api.get<{ results: BestByTaskRow[] }>('/api/brain/routing/best-by-task?days=30&minSamples=3'),
    staleTime: 30_000,
  });
  const { data: decisions } = useQuery<{ decisions: RouteDecision[] }>({
    queryKey: ['routing-decisions'],
    queryFn: () => api.get<{ decisions: RouteDecision[] }>('/api/brain/routing/decisions?limit=10'),
    refetchInterval: 30_000,
  });

  const toggleAutoRoute = useMutation({
    mutationFn: (next: boolean) =>
      api.put<{ ok: boolean }>('/api/brain/config', { autoRoute: next }),
    onSuccess: () => {
      toast.success('Auto-routing updated');
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not update auto-routing'),
  });

  const cfg = brainConfig?.config ?? {};
  const autoRoute = cfg.autoRoute === true;

  const models = useMemo(() => {
    const acc = new Map<string, TrendDay & { wins: number; total: number }>();
    for (const d of trends?.daily ?? []) {
      const key = `${d.model}::${d.provider}`;
      const prev = acc.get(key);
      if (prev) {
        prev.wins += d.wins;
        prev.total += d.total;
        prev.avgTokens = Math.round((prev.avgTokens * prev.total + d.avgTokens * d.total) / (prev.total + d.total));
        prev.avgDurationMs = Math.round(
          (prev.avgDurationMs * prev.total + d.avgDurationMs * d.total) / (prev.total + d.total),
        );
      } else {
        acc.set(key, { ...d });
      }
    }
    return [...acc.values()]
      .filter((m) => m.total > 0)
      .map((m) => ({ ...m, winRate: m.wins / m.total }))
      .sort((a, b) => b.total - a.total);
  }, [trends]);

  const fleet = useMemo(() => {
    const totals = trends?.daily.reduce((s, d) => s + d.total, 0) ?? 0;
    const wins = trends?.daily.reduce((s, d) => s + d.wins, 0) ?? 0;
    const weightedLatency = trends?.daily.reduce(
      (s, d) => s + d.avgDurationMs * d.total,
      0,
    );
    const tokens = trends?.daily.reduce(
      (s, d) => s + d.avgTokens * d.total,
      0,
    );
    return {
      turns: totals,
      winRate: totals > 0 ? wins / totals : null,
      avgLatencyMs: totals > 0 && weightedLatency ? Math.round(weightedLatency / totals) : null,
      avgTokens: totals > 0 && tokens ? Math.round(tokens / totals) : null,
    };
  }, [trends]);

  const daily = useMemo(() => {
    const byDay = new Map<string, { wins: number; total: number }>();
    for (const d of trends?.daily ?? []) {
      const prev = byDay.get(d.day) ?? { wins: 0, total: 0 };
      prev.wins += d.wins;
      prev.total += d.total;
      byDay.set(d.day, prev);
    }
    return [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v, winRate: v.total > 0 ? v.wins / v.total : null }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-14);
  }, [trends]);

  const maxDailyTurns = Math.max(1, ...daily.map((d) => d.total));

  if (!trends || !evals) {
    return <PageLoader label="Loading reliability data…" variant="card" className="py-10" />;
  }

  const hasEvidence = (trends.daily ?? []).length > 0;
  const hasEvals = (evals.runs ?? []).length > 0;

  return (
    <div className="px-8 py-6 max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <HeartPulse className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reliability</h1>
          <p className="text-sm text-muted-foreground">
            Fleet health over the last {trends.rangeDays} days — win rates, latency, cost, and eval pass rates
          </p>
        </div>
        {(trendsFetching || evalsFetching) && (
          <span className="ml-auto text-[10px] text-muted-foreground/70 animate-pulse">Refreshing…</span>
        )}
      </div>

      {/* Auto-routing */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
              <Route className="size-4 text-primary" />
              Evidence-driven auto-routing
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              When routing evidence shows a materially better model for a task type, August
              switches this turn to it automatically — every routed turn is recorded
              (source <code className="font-mono text-[10px]">auto-route</code>) so the loop measures its own decisions.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoRoute}
            disabled={toggleAutoRoute.isPending}
            onClick={() => toggleAutoRoute.mutate(!autoRoute)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              autoRoute ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}
            data-testid="auto-route-toggle"
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-background shadow transition-all ${
                autoRoute ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/80">
          <span className="rounded-full bg-muted/40 px-2 py-0.5">≥ {cfg.autoRouteMinSamples ?? 3} samples</span>
          <span className="rounded-full bg-muted/40 px-2 py-0.5">win rate ≥ {Math.round((cfg.autoRouteMinWinRate ?? 0.6) * 100)}%</span>
          <span className="rounded-full bg-muted/40 px-2 py-0.5">beats current by ≥ {Math.round((cfg.autoRouteWinGap ?? 0.15) * 100)}pts</span>
          <span className="ml-auto text-muted-foreground/60">thresholds live in brain config</span>
        </div>

        {/* Best model per task type */}
        <div>
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Best model per task type</h3>
          {!bestByTask || (bestByTask.results ?? []).length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No task-type evidence yet — the consult needs ≥3 turns of the same task type before it routes.
            </p>
          ) : (
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-1.5 font-medium">Task</th>
                  <th className="pb-1.5 font-medium">Model</th>
                  <th className="pb-1.5 font-medium text-right">Win rate</th>
                  <th className="pb-1.5 font-medium text-right">Turns</th>
                </tr>
              </thead>
              <tbody>
                {bestByTask.results.map((row) => (
                  <tr key={row.taskType} className="border-t border-white/[0.04]">
                    <td className="py-1.5 capitalize">{row.taskType}</td>
                    <td className="py-1.5 font-mono text-foreground/90">
                      {row.model}
                      <span className="ml-1.5 text-muted-foreground/60">{row.provider}</span>
                    </td>
                    <td className="py-1.5 text-right">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                        row.winRate >= 0.75 ? 'bg-emerald-500/15 text-emerald-500'
                        : row.winRate >= 0.5 ? 'bg-amber-500/15 text-amber-500'
                        : 'bg-rose-500/15 text-rose-500'
                      }`}>
                        {pct(row.winRate)}
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent decisions */}
        <div>
          <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">Recent auto-route decisions</h3>
          {!decisions || (decisions.decisions ?? []).length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No decisions yet — {autoRoute ? 'auto-routing is on, waiting for a materially better model.' : 'auto-routing is off; suggestions still appear in the model picker.'}
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {decisions.decisions.map((d, i) => (
                <li key={`${d.at}-${i}`} className="flex items-center gap-2 text-xs py-1 border-t border-white/[0.04] first:border-t-0">
                  <ArrowRight className="size-3 text-primary shrink-0" />
                  <span className="font-mono text-foreground/90 truncate">{d.fromModel || '—'}</span>
                  <span className="text-muted-foreground/50">→</span>
                  <span className="font-mono text-foreground/90 truncate">{d.toModel}</span>
                  <span className="text-muted-foreground/70 capitalize shrink-0">{d.taskType}</span>
                  <span className="ml-auto text-muted-foreground/60 shrink-0">
                    {Math.round(d.winRate * 100)}% · +{Math.round(d.gap * 100)}pts · {new Date(d.at * 1000).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FlaskConical}
          label="Eval pass rate"
          value={pct(evals.passRate)}
          hint={hasEvals ? `${evals.passed}/${evals.total} loop-level tasks` : 'Run the harness suite to populate'}
        />
        <StatCard
          icon={Trophy}
          label="Fleet win rate"
          value={pct(fleet.winRate)}
          hint={hasEvidence ? `${fleet.turns} turns tracked` : 'Builds from real chat outcomes'}
        />
        <StatCard
          icon={Timer}
          label="Avg latency"
          value={fleet.avgLatencyMs ? `${Math.round(fleet.avgLatencyMs / 1000)}s` : '—'}
          hint={hasEvidence ? 'Weighted by turn volume' : 'No evidence yet'}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg tokens / turn"
          value={fleet.avgTokens ? fleet.avgTokens.toLocaleString() : '—'}
          hint={hasEvidence ? 'Input + output' : 'No evidence yet'}
        />
      </div>

      {/* Per-model table */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
        <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
          <HeartPulse className="size-4 text-primary" />
          Model track record
        </h2>
        {!hasEvidence ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No routing evidence yet — every workbench turn records {`{task_type, model, ok, tokens, duration}`} here, so this table fills in as you chat. Arena/debate verdicts count too.
          </p>
        ) : (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium">Provider</th>
                <th className="pb-2 font-medium text-right">Turns</th>
                <th className="pb-2 font-medium text-right">Win rate</th>
                <th className="pb-2 font-medium text-right">Avg latency</th>
                <th className="pb-2 font-medium text-right">Avg tokens</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={`${m.model}::${m.provider}`} className="border-t border-white/[0.04]">
                  <td className="py-1.5 font-mono text-foreground/90">{m.model || '—'}</td>
                  <td className="py-1.5 text-muted-foreground">{m.provider || '—'}</td>
                  <td className="py-1.5 text-right text-muted-foreground">{m.total}</td>
                  <td className="py-1.5 text-right">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      m.winRate >= 0.75 ? 'bg-emerald-500/15 text-emerald-500'
                      : m.winRate >= 0.5 ? 'bg-amber-500/15 text-amber-500'
                      : 'bg-rose-500/15 text-rose-500'
                    }`}>
                      {pct(m.winRate)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground">{fmtDurationMs(m.avgDurationMs)}</td>
                  <td className="py-1.5 text-right text-muted-foreground">{m.avgTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Daily trend */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
        <h2 className="text-sm font-medium text-foreground flex items-center gap-2">
          <TrendingUp className="size-4 text-primary" />
          Daily turn volume
        </h2>
        {!hasEvidence || daily.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">No daily aggregates yet.</p>
        ) : (
          <div className="mt-3 flex items-end gap-1.5 h-24">
            {daily.map((d) => (
              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div className="w-full rounded-t bg-primary/25 relative" style={{ height: `${Math.max(4, (d.total / maxDailyTurns) * 72)}px` }}>
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-t bg-primary/60"
                    style={{ height: `${d.winRate != null ? d.winRate * 100 : 0}%` }}
                    title={`${d.day}: ${d.total} turns, ${pct(d.winRate)} win rate`}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground/70 truncate w-full text-center">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
        {daily.length > 0 && (
          <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-primary/60" /> Win rate</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-primary/25" /> Turn volume</span>
          </div>
        )}
      </div>

      {/* Eval runs */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="size-4 text-primary" />
          <h2 className="text-sm font-medium text-foreground">Recent harness evals</h2>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <button
              type="button"
              disabled={evalsRunning || runEvals.isPending}
              onClick={() => runEvals.mutate()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
              data-testid="run-evals-now"
            >
              {evalsRunning ? <span className="size-3 animate-pulse rounded-full bg-primary-foreground/60" /> : <Play className="size-3" />}
              {evalsRunning ? 'Running…' : 'Run evals now'}
            </button>
            <span className="text-[10px] text-muted-foreground/60">auto-runs every 6h</span>
          </span>
        </div>
        {!hasEvals ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No eval runs recorded — the loop-level golden suite lives in <code className="font-mono text-[10px]">tests/test_harness_evals.py</code>; run it and results land here so harness changes are measurable.
          </p>
        ) : (
          <>
            {evalTrend.length > 1 ? (
              <div
                className="mt-3 flex items-end gap-1 h-10"
                data-testid="eval-pass-trend"
                aria-label="Eval pass rate by day"
              >
                {evalTrend.map((t) => {
                  const share = t.total > 0 ? t.passed / t.total : 0;
                  const tone =
                    share === 0 ? 'bg-rose-500/50' : share === 1 ? 'bg-emerald-500/50' : 'bg-amber-500/50';
                  return (
                    <div
                      key={t.day}
                      className="flex-1 min-w-0 flex flex-col items-center gap-0.5"
                      title={`${t.day}: ${t.passed}/${t.total} passed`}
                    >
                      <div
                        className={`w-full rounded-sm ${tone}`}
                        style={{ height: `${Math.max(10, Math.round(36 * share))}px` }}
                      />
                      <span className="text-[9px] text-muted-foreground/50 truncate w-full text-center">
                        {t.day.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <ul className="mt-3 space-y-1.5">
            {evals.runs.slice(0, 10).map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex items-center gap-2 text-xs py-1 border-t border-white/[0.04] first:border-t-0">
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                  r.passed ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'
                }`}>
                  {r.passed ? <Trophy className="size-2.5" /> : <AlertTriangle className="size-2.5" />}
                  {r.passed ? 'PASS' : 'FAIL'}
                </span>
                <span className="font-mono text-foreground/90 truncate">{r.taskId}</span>
                <span className="text-muted-foreground/70">{r.model}</span>
                <span className="ml-auto text-muted-foreground/70 shrink-0">
                  {r.rounds != null ? `${r.rounds} rounds · ` : ''}{fmtDurationMs(r.durationMs)}
                </span>
                <span className="text-muted-foreground/50 shrink-0">{fmtTime(r.at)}</span>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </div>
  );
}
