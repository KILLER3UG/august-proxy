/* ── WorkspaceUsageSection — Usage dashboard with the screenshot style ─ */
/* 6 stat cards, activity heatmap, tokens-per-day bar chart, model-usage
 * donut. All three visualizations read from /api/usage/* endpoints;
 * the bar chart uses the new /api/usage/by-day endpoint. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Hash,
  MessageSquare,
  Sparkles,
  Activity,
  Flame,
  Star,
  RefreshCw,
} from 'lucide-react';
import { usageApi, type UsageRange } from '@/api/usage';
import { WorkspaceStatCard } from '@/components/workspace/WorkspaceStatCard';
import { WorkspaceHeatmap } from '@/components/workspace/WorkspaceHeatmap';
import { WorkspaceBarChart } from '@/components/workspace/WorkspaceBarChart';
import { WorkspaceDonut } from '@/components/workspace/WorkspaceDonut';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { cn } from '@/lib/utils';

const RANGES: { key: UsageRange; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

export function WorkspaceUsageSection() {
  const [range, setRange] = useState<UsageRange>('30d');
  const [subtab, setSubtab] = useState<string>('app');

  const statsQ = useQuery({
    queryKey: ['ws-usage-stats', range],
    queryFn: () => usageApi.stats(range),
    refetchInterval: 30_000,
  });
  const heatmapQ = useQuery({
    queryKey: ['ws-usage-heatmap', range],
    queryFn: () => usageApi.heatmap(range),
    refetchInterval: 60_000,
  });
  const byModelQ = useQuery({
    queryKey: ['ws-usage-by-model', range],
    queryFn: () => usageApi.byModel(range),
    refetchInterval: 60_000,
  });
  const byDayQ = useQuery({
    queryKey: ['ws-usage-by-day', range],
    queryFn: () => usageApi.byDay(range),
    refetchInterval: 60_000,
  });

  const stats = statsQ.data;
  const heatmap = heatmapQ.data?.results ?? [];
  const byModel = byModelQ.data?.results ?? [];
  const byDay = (byDayQ.data?.results ?? []).map((d) => ({ date: d.date, value: d.tokens }));

  return (
    <div className="px-8 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Usage</h1>
          <p className="mt-1 text-sm text-muted-foreground">App usage</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground/70 uppercase tracking-wider">Time range</span>
          <div className="flex items-center gap-1 rounded-md bg-white/[0.04] p-0.5 border border-white/[0.06]">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition',
                  range === r.key
                    ? 'bg-white/[0.08] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <SettingsTabs
        value={subtab}
        onChange={setSubtab}
        items={[
          { key: 'app', label: 'App usage', icon: Activity },
          { key: 'per-model', label: 'Per model', icon: Star },
        ]}
        label="Usage subviews"
      />

      {subtab === 'app' && (
        <>
          {/* 6 stat cards in 3 columns × 2 rows */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <WorkspaceStatCard
              icon={Hash}
              label="Token usage"
              value={stats ? stats.totalTokens.toLocaleString() : '—'}
              sub={`Across ${stats?.sessions ?? 0} sessions`}
              accent="blue"
            />
            <WorkspaceStatCard
              icon={MessageSquare}
              label="Sessions"
              value={stats?.sessions.toLocaleString() ?? '—'}
              sub={`${stats?.messages.toLocaleString() ?? 0} messages`}
              accent="emerald"
            />
            <WorkspaceStatCard
              icon={Activity}
              label="Active days"
              value={stats?.activeDays.toLocaleString() ?? '—'}
              sub={`Current streak: ${stats?.currentStreak ?? 0}`}
              accent="default"
            />
            <WorkspaceStatCard
              icon={Sparkles}
              label="Messages"
              value={stats?.messages.toLocaleString() ?? '—'}
              sub="in this period"
              accent="default"
            />
            <WorkspaceStatCard
              icon={Flame}
              label="Current streak"
              value={stats?.currentStreak.toLocaleString() ?? '—'}
              sub="consecutive days"
              accent="amber"
            />
            <WorkspaceStatCard
              icon={Star}
              label="Favorite model"
              value={stats?.favoriteModel ?? '—'}
              sub={stats ? `${stats.favoriteModelShare.toFixed(1)}% share` : '—'}
              accent="blue"
            />
          </div>

          {/* Activity heatmap */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Activity heatmap</span>
              <button
                onClick={() => { void heatmapQ.refetch(); }}
                aria-label="Refresh heatmap"
                className="text-muted-foreground hover:text-foreground transition"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <WorkspaceHeatmap cells={heatmap} />
          </div>

          {/* Tokens-per-day bar chart */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Tokens per day</span>
              <button
                onClick={() => { void byDayQ.refetch(); }}
                aria-label="Refresh bar chart"
                className="text-muted-foreground hover:text-foreground transition"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <WorkspaceBarChart bars={byDay} unit="tokens" />
          </div>
        </>
      )}

      {subtab === 'per-model' && (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
          <div className="text-sm font-semibold mb-4">Model usage</div>
          <WorkspaceDonut
            slices={byModel.map((m) => ({
              label: m.model,
              value: m.tokens,
              percent: m.percent,
            }))}
            centerLabel={stats?.totalTokens.toLocaleString() ?? '—'}
            centerSub="tokens"
          />
        </div>
      )}
    </div>
  );
}
