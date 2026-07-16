/* ── Usage ─ Settings → Usage tab (ZCode reference) ────────────── */
/* Stat cards (3×2 grid) + GitHub-style activity heatmap + model-share */
/* donut chart. Reads from /api/usage/{stats,heatmap,by-model}.            */
/*                                                                          */
/* Layout:                                                                   */
/*   • Time-range toggle (Last 7 days / Last 30 days) at the top-right      */
/*   • 3×2 stat card grid: Tokens, Sessions, Messages, Active days,         */
/*     Current streak, Favorite model                                         */
/*   • Activity heatmap (5 rows × N cols of 9-px squares, 4 intensity levels) */
/*   • Model share donut + legend on the right                                */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, Flame, Hash, MessageSquare, Sparkles, Star } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';
import { usageApi, type UsageRange } from '@/api/usage';
import { cn } from '@/lib/utils';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface StatCardProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  sub?: string;
  accent?: 'default' | 'emerald' | 'amber' | 'blue';
}
function StatCard({ icon: Icon, label, value, sub, accent = 'default' }: StatCardProps) {
  const accentColor = {
    default: 'text-muted-foreground',
    emerald: 'text-success',
    amber: 'text-warning',
    blue: 'text-info',
  }[accent];
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
        <Icon size={11} className={accentColor} />
        {label}
      </div>
      <div className="text-[22px] font-semibold tabular-nums leading-none">
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-muted-foreground/70">{sub}</div>}
    </div>
  );
}

/** GitHub-style 5-row × N-col activity heatmap. */
function Heatmap({ cells }: { cells: { date: string; count: number }[] }) {
  // 5 rows × ceil(N/7) cols, oldest at top-left
  const max = Math.max(1, ...cells.map(c => c.count));
  const _cols = Math.ceil(cells.length / 5);
  const grid: { count: number; date: string }[][] = Array.from({ length: 5 }, () => []);
  cells.forEach((cell, i) => {
    const col = Math.floor(i / 5);
    grid[col].push(cell);
  });

  const intensity = (count: number): string => {
    if (count === 0) return 'bg-white/[0.025]';
    const ratio = count / max;
    if (ratio < 0.25) return 'bg-success/40';
    if (ratio < 0.5)  return 'bg-success/60';
    if (ratio < 0.75) return 'bg-success/80';
    return 'bg-success';
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
          <Activity size={11} className="text-success" />
          Activity heatmap
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
          <span>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span
              key={p}
              className={cn('size-[9px] rounded-[2px]', intensity(p * max))}
            />
          ))}
          <span>More</span>
        </div>
      </div>
      <div className="flex gap-[2px] overflow-x-auto pb-1">
        {grid.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-[2px]">
            {col.map((cell, ri) => (
              <div
                key={`${ci}-${ri}`}
                className={cn('size-[9px] rounded-[2px]', intensity(cell.count))}
                title={`${cell.date}: ${cell.count} messages`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** SVG donut chart for model share. */
function Donut({ data, total }: { data: { model: string; tokens: number; percent: number }[]; total: number }) {
  const R = 36;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const palette = ['#3b7eff', '#4ade80', '#f59e0b', '#f87171', '#a78bfa', '#06b6d4', '#ec4899', '#84cc16'];

  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
        <BarChart3 size={11} className="text-blue-500" />
        Model share
      </div>
      <div className="flex items-center gap-5">
        <svg width={96} height={96} viewBox="0 0 96 96" className="shrink-0">
          <circle cx={48} cy={48} r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={14} />
          {data.map((slice, i) => {
            const length = (slice.percent / 100) * C;
            const dashArray = `${length} ${C}`;
            const seg = (
              <circle
                key={slice.model + i}
                cx={48}
                cy={48}
                r={R}
                fill="none"
                stroke={palette[i % palette.length]}
                strokeWidth={14}
                strokeDasharray={dashArray}
                strokeDashoffset={-offset}
                transform="rotate(-90 48 48)"
                style={{ transition: 'stroke-dasharray 0.3s ease' }}
              />
            );
            offset += length;
            return seg;
          })}
          <text x={48} y={46} textAnchor="middle" className="fill-foreground" style={{ fontSize: 13, fontWeight: 600 }} fontFamily="ui-monospace, monospace">
            {formatNumber(total)}
          </text>
          <text x={48} y={60} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 7 }} fontFamily="ui-monospace, monospace">
            tokens
          </text>
        </svg>
        <div className="flex-1 min-w-0 space-y-1">
          {data.length === 0 && <div className="text-[11px] text-muted-foreground/60">No usage yet.</div>}
          {data.slice(0, 6).map((slice, i) => (
            <div key={slice.model + i} className="flex items-center gap-2 text-[11.5px] min-w-0">
              <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: palette[i % palette.length] }} />
              <span className="truncate flex-1 text-foreground/90">{slice.model || 'unknown'}</span>
              <span className="font-mono tabular-nums text-muted-foreground shrink-0">{slice.percent.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Usage() {
  const [range, setRange] = useState<UsageRange>('30d');

  // Poll every 5s so stats, heatmap, and by-model stay current as new
  // usage events land. Stops on unmount.
  const refetchMs = 5000;
  const stats = useQuery({
    queryKey: ['usage', 'stats', range],
    queryFn: () => usageApi.stats(range),
    refetchInterval: refetchMs,
  });
  const heatmap = useQuery({
    queryKey: ['usage', 'heatmap', range],
    queryFn: () => usageApi.heatmap(range),
    refetchInterval: refetchMs,
  });
  const byModel = useQuery({
    queryKey: ['usage', 'by-model', range],
    queryFn: () => usageApi.byModel(range),
    refetchInterval: refetchMs,
  });

  if (stats.isLoading || heatmap.isLoading || byModel.isLoading) {
    return <PageLoader label="Loading usage…" variant="card" />;
  }

  const s = stats.data;
  const total = s?.totalTokens || 0;

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Usage"
        actions={
          <div className="inline-flex rounded-lg border border-white/[0.06] bg-card/60 p-0.5 text-[11.5px]">
            {(['7d', '30d'] as UsageRange[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  'px-2.5 py-1 rounded-md transition-colors',
                  range === r ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {r === '7d' ? 'Last 7 days' : 'Last 30 days'}
              </button>
            ))}
          </div>
        }
      />

      {!s || total === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-8 text-center text-muted-foreground/60 text-sm">
          No usage data yet. Once you start a few sessions, your tokens, sessions, and model share will appear here.
        </div>
      ) : (
        <>
          {/* Stat card grid (3 × 2) */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard icon={Hash}        label="Token usage"        value={formatNumber(s.totalTokens)}      sub={s.range === '7d' ? 'last 7 days' : 'last 30 days'} accent="blue" />
            <StatCard icon={MessageSquare} label="Sessions"         value={String(s.sessions)}             sub="distinct sessions" accent="emerald" />
            <StatCard icon={Sparkles}    label="Messages"           value={formatNumber(s.messages)}        sub="across all sessions" />
            <StatCard icon={Activity}    label="Active days"        value={String(s.activeDays)}           sub="with at least one session" accent="emerald" />
            <StatCard icon={Flame}       label="Current streak"     value={String(s.currentStreak)}        sub="consecutive days" accent="amber" />
            <StatCard
              icon={Star}
              label="Favorite model"
              value={s.favoriteModel ? s.favoriteModel : '—'}
              sub={s.favoriteModel ? `${s.favoriteModelShare.toFixed(1)}% share` : 'no model data'}
              accent="blue"
            />
          </div>

          {/* Heatmap + donut */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2">
              <Heatmap cells={heatmap.data?.results || []} />
            </div>
            <Donut data={byModel.data?.results || []} total={total} />
          </div>
        </>
      )}
    </div>
  );
}
