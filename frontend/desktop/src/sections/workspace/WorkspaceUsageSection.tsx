/* ── WorkspaceUsageSection — Modern "Usage stats" Dashboard ─────────── */
/* Matches reference designs with 5 metric cards, 12-month Token activity
 * heatmap (Daily/Weekly/Cumulative), Daily token trend chart with tooltip,
 * and Model usage donut. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { usageApi, type UsageRange } from '@/api/usage';
import { WorkspaceHeatmap } from '@/components/workspace/WorkspaceHeatmap';
import { WorkspaceTrendChart } from '@/components/workspace/WorkspaceTrendChart';
import { WorkspaceDonut } from '@/components/workspace/WorkspaceDonut';
import { cn } from '@/lib/utils';

const RANGES: { key: UsageRange; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

type ActivityMode = 'daily' | 'weekly' | 'cumulative';

function formatShortTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return tokens > 0 ? tokens.toLocaleString() : '0';
}

export function WorkspaceUsageSection() {
  const [range, setRange] = useState<UsageRange>('7d');
  const [activityMode, setActivityMode] = useState<ActivityMode>('daily');

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
  const rawHeatmap = heatmapQ.data?.results ?? [];
  const byModel = byModelQ.data?.results ?? [];
  const byDay = byDayQ.data?.results ?? [];

  // 100% Real Live Computed Stats from SQLite
  const totalTokensNum = stats?.totalTokens ?? 0;
  const totalTokensDisplay = formatShortTokens(totalTokensNum);
  const peakTokensDisplay = formatShortTokens(stats?.peakTokens ?? 0);
  const currentStreakDisplay = `${stats?.currentStreak ?? 0} d`;
  const longestStreakDisplay = `${stats?.longestStreak ?? 0} d`;
  const sessionsCountDisplay = `${stats?.sessions ?? 0} sessions`;

  // Real trend data for spline chart
  const trendData = byDay.map((d) => ({
    date: d.date,
    tokens: d.tokens,
    models: d.models ?? [],
  }));

  // Real model breakdown for donut chart
  const modelSlices = byModel.map((m) => ({
    label: m.model,
    value: m.tokens,
    percent: m.percent,
  }));

  const handleRefresh = () => {
    void statsQ.refetch();
    void heatmapQ.refetch();
    void byModelQ.refetch();
    void byDayQ.refetch();
  };

  return (
    <div className="px-8 py-6 space-y-6 max-w-5xl mx-auto pb-24 relative">
      {/* Title Header with App usage pill badge */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Usage stats</h1>
        <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-3 py-0.5 text-xs font-medium text-muted-foreground/80">
          App usage
        </span>
      </div>

      {/* 5-Card Metric Overview Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 text-center flex flex-col justify-center">
          <div className="text-xl font-bold tracking-tight text-foreground">{totalTokensDisplay}</div>
          <div className="mt-1 text-xs text-muted-foreground">Total tokens</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 text-center flex flex-col justify-center">
          <div className="text-xl font-bold tracking-tight text-foreground">{peakTokensDisplay}</div>
          <div className="mt-1 text-xs text-muted-foreground">Peak tokens</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 text-center flex flex-col justify-center">
          <div className="text-xl font-bold tracking-tight text-foreground">{sessionsCountDisplay}</div>
          <div className="mt-1 text-xs text-muted-foreground">Active sessions</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 text-center flex flex-col justify-center">
          <div className="text-xl font-bold tracking-tight text-foreground">{currentStreakDisplay}</div>
          <div className="mt-1 text-xs text-muted-foreground">Current streak</div>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 text-center flex flex-col justify-center">
          <div className="text-xl font-bold tracking-tight text-foreground">{longestStreakDisplay}</div>
          <div className="mt-1 text-xs text-muted-foreground">Longest streak</div>
        </div>
      </div>

      {/* Token Activity Heatmap Card */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm font-semibold text-foreground">Token activity</span>
          <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5 border border-white/[0.06]">
            {(['daily', 'weekly', 'cumulative'] as ActivityMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setActivityMode(mode)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                  activityMode === mode
                    ? 'bg-white/[0.08] text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
        <WorkspaceHeatmap cells={rawHeatmap} />
      </div>

      {/* Time Range Selector */}
      <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Time range</span>
        <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5 border border-white/[0.06]">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                range === r.key
                  ? 'bg-white/[0.08] text-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Daily Token Trend Chart Card */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div className="text-sm font-semibold text-foreground">Daily token trend chart</div>
        {trendData.length > 0 && trendData.some((t) => t.tokens > 0) ? (
          <WorkspaceTrendChart data={trendData} />
        ) : (
          <div className="py-12 text-center text-xs text-muted-foreground">
            No token activity recorded in the selected time range. Chat with any model to see real-time usage trends.
          </div>
        )}
      </div>

      {/* Model Usage Donut Card */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-2">
        <div className="text-sm font-semibold text-foreground mb-2">Model usage</div>
        {modelSlices.length > 0 ? (
          <WorkspaceDonut
            slices={modelSlices}
            centerLabel={formatShortTokens(modelSlices.reduce((acc, s) => acc + s.value, 0))}
            centerSub="tokens"
          />
        ) : (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No model consumption recorded yet.
          </div>
        )}
      </div>

      {/* Floating Refresh Button in bottom right */}
      <div className="fixed bottom-6 right-8 z-30">
        <button
          onClick={handleRefresh}
          className="flex items-center gap-2 rounded-xl border border-white/[0.1] bg-[#1c1d22]/90 backdrop-blur-md px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-[#25272e] shadow-lg transition-all"
        >
          <RefreshCw className={cn('size-3.5', statsQ.isFetching ? 'animate-spin' : '')} />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}

