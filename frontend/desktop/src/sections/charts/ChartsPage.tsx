/* ── Charts — the Signal Desk chart surface, fed by real usage ─────────
 *
 * The mockup's Charts screen shipped here as a designed sample (its
 * deepseek/qwen fixture was an approved stopgap while the surface proved the
 * layout). That fixture is gone: every number now comes from the live usage
 * endpoints the Usage page and the sidebar card already read —
 *
 *   GET /api/usage/stats    → totals, peak day, sessions, favorite model
 *   GET /api/usage/by-day   → billed tokens per day, split by model
 *   GET /api/usage/by-model → per-model share of the range
 *   GET /api/usage/heatmap  → activity (events) per day
 *
 * Three chart views over that data — tokens by day, activity by day, model
 * split — render through the mockup's own DOM (.dashboard / .side-card /
 * .gallery-card, styled by styles/signal-desk.css). Nothing on this page is
 * sample data: when an install has no usage the charts honestly render zeros
 * and the readout says so.
 */

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
import { usageApi } from '@/api/usage';
import type { DailyTokens, HeatmapCell, ModelShare } from '@/api/usage';
import { dispatchInsertComposerText } from '@/api/ui-events';
import { createSession } from '@/store/sessions';
import { copyFigurePng, downloadFigurePng } from '@/lib/svg-figure';

type ChartMode = 'line' | 'area' | 'bars';
type ChartViewKey = 'tokens' | 'activity' | 'models';
type UsageRange = '7d' | '30d';

interface Series {
  name: string;
  color: string;
  values: number[];
}

interface Share {
  name: string;
  color: string;
  percent: number;
}

/** One selectable chart: a view over the usage data the queries returned. */
interface ChartSpec {
  key: ChartViewKey;
  title: string;
  kind: 'series' | 'donut';
  defaultMode: ChartMode;
  /** Series views: one line per model (or the single activity series), plus
   *  the per-day totals that drive the side bars and the peak marker. */
  series: Series[];
  shares: Share[];
  totals: number[];
  axis: string[];
}

const C1 = 'var(--dt-chart-1)';
const C2 = 'var(--dt-chart-2)';
const C3 = 'var(--dt-chart-3)';
const C4 = 'var(--dt-chart-4)';
const SERIES_COLORS = [C1, C2, C3, C4];
const DONUT_COLORS = [C1, C2, C3, C4, 'var(--dt-chart-5)', 'var(--dt-chart-6)'];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TOP_MODELS = 3;

/** Compact token count for axis ticks and metric values (18.4M, 912k, 8). */
function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/** Continuous YYYY-MM-DD axis ending today, so days with no usage rows plot
 *  as the zeros they are instead of compressing the axis. */
function dayAxis(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const t = new Date(now);
    t.setDate(now.getDate() - i);
    out.push(
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    );
  }
  return out;
}

/** "Apr 01" from an axis date. */
function dayLabel(iso: string): string {
  const t = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

/** "Tue · Apr 16" for the peak tooltip. */
function dayLabelLong(iso: string): string {
  const t = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(t.getTime())) return iso;
  const wk = t.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  return `${wk} · ${dayLabel(iso).toUpperCase()}`;
}

function niceMax(value: number): number {
  // A floor of 4 keeps the tick ladder sane when a range's usage is single
  // digits: the axis headroom is scale, not data, and the data still plots
  // honestly against it.
  if (value <= 0) return 4;
  const exp = Math.floor(Math.log10(value));
  const half = Math.pow(10, exp) / 2;
  return Math.max(4, Math.ceil(value / half) * half);
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const PLOT = { width: 760, height: 300, left: 46, right: 16, top: 18, bottom: 30 };

function xAt(index: number, count: number): number {
  if (count <= 1) return PLOT.left;
  return PLOT.left + (index * (PLOT.width - PLOT.left - PLOT.right)) / (count - 1);
}

function yAt(value: number, max: number): number {
  return PLOT.top + (1 - value / max) * (PLOT.height - PLOT.top - PLOT.bottom);
}

interface Point {
  x: number;
  y: number;
}

/** Catmull-Rom through the data points, emitted as cubic beziers — the
 *  mockup's lines are drawn smooth (`C`/`S` segments), and polylines read
 *  as a different chart. */
function smoothPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function SeriesChart({
  spec,
  mode,
  max,
  highlight,
}: {
  spec: ChartSpec;
  mode: ChartMode;
  max: number;
  highlight: { index: number; label: string; value: string; note: string } | null;
}) {
  const count = spec.axis.length;
  const baseline = PLOT.height - PLOT.bottom;
  const groups = spec.series.length;
  const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) => fmtTokens(max * f));
  const xLabelIdx = useMemo(() => {
    const want = Math.min(5, count);
    const step = (count - 1) / Math.max(want - 1, 1);
    return Array.from({ length: want }, (_, i) => Math.round(i * step));
  }, [count]);

  return (
    <svg
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      role="img"
      aria-label={`${spec.title} chart`}
      className="block h-auto w-full"
    >
      <defs>
        <linearGradient id={`big-fill-${spec.key}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={SERIES_COLORS[0]} stopOpacity=".2" />
          <stop offset="1" stopColor={SERIES_COLORS[0]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--dt-line)" strokeWidth="1">
        {yLabels.map((_, index) => {
          const y = PLOT.top + (index * (PLOT.height - PLOT.top - PLOT.bottom)) / (yLabels.length - 1);
          return <line key={index} x1={PLOT.left} y1={y} x2={PLOT.width - PLOT.right} y2={y} />;
        })}
      </g>
      <g fontFamily={MONO} fontSize="9" fill="var(--dt-muted-foreground)">
        {yLabels.map((label, index) => {
          const y = PLOT.top + (index * (PLOT.height - PLOT.top - PLOT.bottom)) / (yLabels.length - 1);
          return (
            <text key={`${label}-${index}`} x={8} y={y + 3}>
              {label}
            </text>
          );
        })}
        {xLabelIdx.map((axisIndex) => {
          const anchor =
            axisIndex === 0 ? 'start' : axisIndex === count - 1 ? 'end' : 'middle';
          return (
            <text key={spec.axis[axisIndex]} x={xAt(axisIndex, count)} y={PLOT.height - 8} textAnchor={anchor}>
              {dayLabel(spec.axis[axisIndex])}
            </text>
          );
        })}
      </g>

      {mode === 'bars'
        ? spec.series.map((series, seriesIndex) => {
            const groupWidth = (PLOT.width - PLOT.left - PLOT.right) / Math.max(count, 1);
            const barWidth = Math.max(2, (groupWidth * 0.62) / groups);
            return series.values.map((value, index) => {
              const x = xAt(index, count) - (groupWidth * 0.31) + seriesIndex * barWidth;
              const y = yAt(value, max);
              return (
                <rect
                  key={`${series.name}-${index}`}
                  x={x}
                  y={y}
                  width={barWidth - 1}
                  height={baseline - y}
                  rx={1.5}
                  fill={series.color}
                  opacity={seriesIndex === 0 ? 0.95 : 0.72}
                />
              );
            });
          })
        : spec.series.map((series, index) => {
            const points = series.values.map((value, pointIndex) => ({
              x: xAt(pointIndex, count),
              y: yAt(value, max),
            }));
            const line = smoothPath(points);
            const primary = index === 0;
            return (
              <g key={series.name}>
                {(primary || mode === 'area') && (
                  <path
                    d={`${line} L${points[points.length - 1].x.toFixed(1)} ${baseline} L${points[0].x.toFixed(1)} ${baseline} Z`}
                    fill={primary ? `url(#big-fill-${spec.key})` : series.color}
                    opacity={primary && mode === 'area' ? 0.34 : primary ? 1 : 0.08}
                  />
                )}
                <path
                  d={line}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={primary ? 2.6 : index === 1 ? 2 : 1.8}
                  strokeLinecap="round"
                  className={primary ? 'chart-line' : `chart-line delay-${Math.min(index, 2)}`}
                />
              </g>
            );
          })}

      {highlight && highlight.index >= 0 && count > 0 && (
        <g>
          <line
            x1={xAt(highlight.index, count)}
            y1={PLOT.top}
            x2={xAt(highlight.index, count)}
            y2={baseline}
            stroke={SERIES_COLORS[0]}
            strokeOpacity=".4"
            strokeDasharray="2 5"
          />
          {spec.series.map((series, index) => (
            <circle
              key={series.name}
              cx={xAt(highlight.index, count)}
              cy={yAt(series.values[highlight.index] ?? 0, max)}
              r={index === 0 ? 4.5 : 3.5}
              fill={series.color}
              stroke="var(--dt-stage)"
              strokeWidth="2"
            />
          ))}
          <g transform={`translate(${Math.min(Math.max(xAt(highlight.index, count) - 58, PLOT.left), PLOT.width - 170)} ${PLOT.top + 6})`}>
            <rect width="116" height="56" rx="7" fill="var(--dt-card)" stroke="var(--dt-line-strong)" />
            <text x="9" y="15" fontFamily={MONO} fontSize="7" fill="var(--dt-muted-foreground)">{highlight.label}</text>
            <text x="9" y="29" fontFamily={MONO} fontSize="10" fill="var(--dt-foreground)">{highlight.value}</text>
            <text x="9" y="43" fontFamily={MONO} fontSize="7" fill={SERIES_COLORS[0]}>{highlight.note}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

function DonutChart({ spec, total }: { spec: ChartSpec; total: string }) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-8 sm:flex-row sm:gap-10">
      <svg viewBox="0 0 220 220" role="img" aria-label={`${spec.title} donut chart`} className="size-[220px]">
        <circle cx="110" cy="110" r={radius} fill="none" stroke="var(--dt-muted)" strokeWidth="22" />
        {spec.series.map((series) => {
          const percent = series.values[0] ?? 0;
          const dash = (percent / 100) * circumference;
          const element = (
            <circle
              key={series.name}
              cx="110"
              cy="110"
              r={radius}
              fill="none"
              stroke={series.color}
              strokeWidth="22"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 110 110)"
              strokeLinecap="butt"
            />
          );
          offset += dash;
          return element;
        })}
        <text x="110" y="104" textAnchor="middle" fontFamily={MONO} fontSize="9" fill="var(--dt-muted-foreground)">BILLED</text>
        <text x="110" y="128" textAnchor="middle" fontFamily={MONO} fontSize="20" fill="var(--dt-foreground)">{total}</text>
      </svg>
      <div className="w-full max-w-[220px] space-y-2.5">
        {spec.shares.map((share) => (
          <div key={share.name} className="flex items-center gap-2 text-[0.78rem]">
            <svg className="size-2 shrink-0" viewBox="0 0 8 8" aria-hidden="true">
              <circle cx="4" cy="4" r="4" fill={share.color} />
            </svg>
            <span className="min-w-0 flex-1 text-muted-foreground">{share.name}</span>
            <span className="font-mono text-[0.7rem] text-foreground/80">{share.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── The gallery minis (`.gallery-visual`), one per chart view ────────── */

const MINI = { width: 240, height: 104, pad: 12 };

function miniLinePath(values: number[], max: number, top: number, span: number): string {
  const n = values.length;
  const points = values.map((value, index) => ({
    x: MINI.pad + (index * (MINI.width - MINI.pad * 2)) / Math.max(n - 1, 1),
    y: top + (1 - value / max) * span,
  }));
  return smoothPath(points);
}

function MiniLine({ series }: { series: Series[] }) {
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const [first, second] = series;
  return (
    <svg viewBox={`0 0 ${MINI.width} ${MINI.height}`} aria-hidden="true">
      <path d={`M0 84h${MINI.width}M0 56h${MINI.width}M0 28h${MINI.width}`} stroke="var(--dt-line)" />
      {first && <path d={miniLinePath(first.values, max, 16, 68)} fill="none" stroke={first.color} strokeWidth="2.2" />}
      {second && <path d={miniLinePath(second.values, max, 46, 48)} fill="none" stroke={second.color} strokeWidth="1.6" />}
    </svg>
  );
}

function MiniBars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 0);
  return (
    <svg viewBox={`0 0 ${MINI.width} ${MINI.height}`} aria-hidden="true">
      <g fill={color}>
        {values.map((value, index) => {
          const height = max > 0 ? Math.max(2, (value / max) * 72) : 2;
          return <rect key={index} x={12 + (index * (MINI.width - 24)) / Math.max(values.length - 1, 1)} y={90 - height} width={Math.max(6, (MINI.width - 24) / values.length - 4)} height={height} rx="2" />;
        })}
      </g>
      <path d={`M0 90h${MINI.width}`} stroke="var(--dt-line)" />
    </svg>
  );
}

function MiniDonut({ shares }: { shares: Share[] }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${MINI.width} ${MINI.height}`} aria-hidden="true">
      <circle cx="120" cy="52" r={radius} fill="none" stroke="var(--dt-elevated)" strokeWidth="13" />
      {shares.map((share) => {
        const dash = (share.percent / 100) * circumference;
        const element = (
          <circle
            key={share.name}
            cx="120"
            cy="52"
            r={radius}
            fill="none"
            stroke={share.color}
            strokeWidth="13"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 120 52)"
          />
        );
        offset += dash;
        return element;
      })}
    </svg>
  );
}

/** Eight `.side-bars` samples down the per-day totals; the accent marks the
 *  actual peak (the stylesheet's fixed `nth-child(5)` accent is re-aimed at
 *  `[data-max]` in the app-extension block of signal-desk.css). */
function SideBars({ values }: { values: number[] }) {
  if (!values.length) return null;
  const max = Math.max(...values);
  const step = (values.length - 1) / 7;
  const picked = Array.from({ length: 8 }, (_, i) => values[Math.round(i * step)] ?? 0);
  const peak = Math.max(...picked);
  return (
    <div className="side-bars" aria-hidden="true">
      {picked.map((value, index) => (
        <span
          key={index}
          data-max={value === peak || undefined}
          style={{ height: `${max > 0 ? Math.max(6, (value / max) * 100) : 4}%` }}
        />
      ))}
    </div>
  );
}

/** Everything the page renders, derived from the four usage queries. */
function useChartSpecs(range: UsageRange) {
  const days = range === '7d' ? 7 : 30;
  const stats = useQuery({
    queryKey: ['charts-usage-stats', range],
    queryFn: () => usageApi.stats(range),
  });
  const byDay = useQuery({
    queryKey: ['charts-usage-by-day', range],
    queryFn: () => usageApi.byDay(range),
  });
  const byModel = useQuery({
    queryKey: ['charts-usage-by-model', range],
    queryFn: () => usageApi.byModel(range),
  });
  const heat = useQuery({
    queryKey: ['charts-usage-heatmap', range],
    queryFn: () => usageApi.heatmap(range),
  });

  return useMemo(() => {
    const axis = dayAxis(days);
    const byDayMap = new Map<string, DailyTokens>(
      (byDay.data?.results ?? []).map((row) => [row.date, row]),
    );
    const perDayModels = axis.map(
      (date) => byDayMap.get(date)?.models ?? [],
    );
    const totals = perDayModels.map((models) => models.reduce((sum, m) => sum + m.tokens, 0));

    const heatMap = new Map<string, HeatmapCell>(
      (heat.data?.results ?? []).map((row) => [row.date, row]),
    );
    const counts = axis.map((date) => heatMap.get(date)?.count ?? 0);

    const shares: ModelShare[] = byModel.data?.results ?? [];

    // One line per top model, the tail merged into "other" — the legend and
    // the wire format both stay readable at more than three models.
    const modelTotals = new Map<string, number>();
    for (const models of perDayModels) {
      for (const m of models) modelTotals.set(m.model, (modelTotals.get(m.model) ?? 0) + m.tokens);
    }
    const ranked = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, TOP_MODELS).map(([model]) => model);
    const tokenSeries: Series[] = top.map((model, index) => ({
      name: model,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      values: perDayModels.map((models) => models.find((m) => m.model === model)?.tokens ?? 0),
    }));
    const restTotal = ranked.slice(TOP_MODELS).reduce((sum, [, tokens]) => sum + tokens, 0);
    if (restTotal > 0) {
      tokenSeries.push({
        name: 'other',
        color: SERIES_COLORS[TOP_MODELS % SERIES_COLORS.length],
        values: totals.map(
          (total, index) =>
            total - tokenSeries.reduce((sum, s) => sum + (s.values[index] ?? 0), 0),
        ),
      });
    }

    const donutShares: Share[] = shares
      .slice(0, DONUT_COLORS.length)
      .map((share, index) => ({
        name: share.model,
        color: DONUT_COLORS[index % DONUT_COLORS.length],
        percent: share.percent,
      }));
    const donutSeries: Series[] = donutShares.map((share) => ({
      name: share.name,
      color: share.color,
      values: [share.percent],
    }));

    const specs: Record<ChartViewKey, ChartSpec> = {
      tokens: {
        key: 'tokens',
        title: 'Tokens by day',
        kind: 'series',
        defaultMode: 'line',
        series: tokenSeries,
        shares: donutShares,
        totals,
        axis,
      },
      activity: {
        key: 'activity',
        title: 'Activity by day',
        kind: 'series',
        defaultMode: 'bars',
        series: [{ name: 'events', color: C1, values: counts }],
        shares: donutShares,
        totals: counts,
        axis,
      },
      models: {
        key: 'models',
        title: 'Model split',
        kind: 'donut',
        defaultMode: 'line',
        series: donutSeries,
        shares: donutShares,
        totals: [],
        axis: [],
      },
    };

    return {
      specs,
      stats: stats.data,
      modelCount: shares.length,
      loading: stats.isLoading || byDay.isLoading || byModel.isLoading,
      error: stats.isError && byDay.isError && byModel.isError,
      totalDays: days,
    };
  }, [byDay.data, byModel.data, days, heat.data, stats.data, stats.isLoading, byDay.isLoading, byModel.isLoading, stats.isError, byDay.isError, byModel.isError]);
}

export function ChartsPage() {
  const navigate = useNavigate();
  const [range, setRange] = useState<UsageRange>('30d');
  const [viewKey, setViewKey] = useState<ChartViewKey>('tokens');
  const [mode, setMode] = useState<ChartMode>('line');
  const chartHostRef = useRef<HTMLDivElement>(null);

  const { specs, stats, modelCount, loading, error, totalDays } = useChartSpecs(range);
  const spec = specs[viewKey];
  const max = niceMax(Math.max(...spec.totals, 0));

  // The peak marker and its tooltip are computed facts, not an annotation
  // anyone wrote: the day the range actually peaked, and what that day was.
  // An all-zero range has no peak to mark.
  const rangeMax = Math.max(...spec.totals, 0);
  const peakIndex = spec.totals.length ? spec.totals.indexOf(rangeMax) : -1;
  const highlight =
    spec.kind === 'series' && rangeMax > 0 && peakIndex >= 0
      ? {
          index: peakIndex,
          label: dayLabelLong(spec.axis[peakIndex]),
          value: `${fmtTokens(spec.totals[peakIndex])} ${viewKey === 'activity' ? 'events' : 'tokens'}`,
          note: spec.series[0]?.name ?? '',
        }
      : null;

  const selectView = (next: ChartSpec) => {
    setViewKey(next.key);
    setMode(next.defaultMode);
  };

  const chartSvg = () => chartHostRef.current?.querySelector('svg') as SVGSVGElement | null;
  const downloadChart = () => {
    const svg = chartSvg();
    if (!svg) return;
    void downloadFigurePng(svg, spec.title)
      .then(() => toast.success('Chart downloaded as PNG.'))
      .catch(() => toast.error('Could not export the chart.'));
  };
  const copyChart = () => {
    const svg = chartSvg();
    if (!svg) return;
    void copyFigurePng(svg)
      .then(() => toast.success('Chart copied as a PNG.'))
      .catch(() => toast.error('Copy is blocked here — use Download instead.'));
  };

  const seed = (text: string) => {
    // A chart action starts a NEW thread, like the mockup's launchpad flow;
    // reusing the active chat would append the prompt to whatever draft is
    // open there.
    const session = createSession(null);
    void navigate(`/c/${session.id}`);
    window.setTimeout(() => dispatchInsertComposerText(text, { replace: true }), 220);
  };

  // Every clause is a server fact from the stats endpoint — the readout is
  // written from the data, never authored about it.
  const readout = error
    ? 'Usage is unavailable right now — the charts come back with the backend.'
    : loading && !stats
      ? 'Loading usage…'
      : !stats || stats.totalTokens <= 0
        ? `No usage recorded in this range yet. The charts fill in as chats run.`
        : (() => {
            const peakAt = peakIndex >= 0 ? dayLabel(spec.totals.length === spec.axis.length ? spec.axis[peakIndex] : '') : '';
            const peakClause =
              stats.peakTokens > 0
                ? `The peak day hit ${fmtTokens(stats.peakTokens)} tokens${peakAt ? ` (${peakAt})` : ''}. `
                : '';
            const modelClause = stats.favoriteModel
              ? `${stats.favoriteModel} carried ${Math.round(stats.favoriteModelShare)}% of billed tokens. `
              : '';
            const daysClause = `${stats.activeDays} active day${stats.activeDays === 1 ? '' : 's'} · ${stats.sessions} chat${stats.sessions === 1 ? '' : 's'}.`;
            return `${peakClause}${modelClause}${daysClause}`;
          })();

  const cardSub = error
    ? 'Usage data unavailable'
    : loading && !stats
      ? 'Loading usage…'
      : `${modelCount} model${modelCount === 1 ? '' : 's'} · ${totalDays} days · ${timeAgo(stats?.at) || 'live'}`;

  return (
    <div className="page-screen">
      <div className="page-inner">
        <SectionHeader
          eyebrow="Output / data"
          title="Charts"
          subtitle="Every chart August has rendered, with the data and the reasoning still attached."
          actions={
            <>
              <Button
                type="button"
                variant="bare"
                className="ghost-button"
                onClick={() => seed('Analyze this dataset. I will attach the file next.')}
              >
                <SignalIcon name="table" /> Import data
              </Button>
              <Button type="button" variant="bare" className="solid-button" onClick={() => seed('Create a chart showing ')}>
                <SignalIcon name="plus" /> New chart
              </Button>
            </>
          }
        />

        <div className="dashboard">
          <section className="dashboard-card dashboard-main">
            <div className="card-head">
              <div>
                <h2 className="card-title">{spec.title}</h2>
                <p className="card-sub">{cardSub}</p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="segmented" role="tablist" aria-label="Chart range">
                  {(['7d', '30d'] as UsageRange[]).map((item) => (
                    <Button
                      key={item}
                      type="button"
                      variant="bare"
                      role="tab"
                      aria-selected={range === item}
                      data-active={range === item}
                      onClick={() => setRange(item)}
                    >
                      {item}
                    </Button>
                  ))}
                </div>
                {spec.kind === 'series' && (
                  <div className="segmented" role="tablist" aria-label="Chart shape">
                    {(['line', 'area', 'bars'] as ChartMode[]).map((item) => (
                      <Button
                        key={item}
                        type="button"
                        variant="bare"
                        role="tab"
                        aria-selected={mode === item}
                        data-active={mode === item}
                        onClick={() => setMode(item)}
                      >
                        {item}
                      </Button>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  variant="bare"
                  className="icon-button"
                  onClick={downloadChart}
                  title="Download chart as PNG"
                  aria-label="Download chart as PNG"
                >
                  <SignalIcon name="download" />
                </Button>
                <Button
                  type="button"
                  variant="bare"
                  className="icon-button"
                  onClick={copyChart}
                  title="Copy chart as image"
                  aria-label="Copy chart as image"
                >
                  <SignalIcon name="copy" />
                </Button>
              </div>
            </div>
            <div ref={chartHostRef} className="big-chart">
              {spec.kind === 'donut' ? (
                <DonutChart spec={spec} total={fmtTokens(stats?.totalTokens ?? 0)} />
              ) : (
                <SeriesChart spec={spec} mode={mode} max={max} highlight={highlight} />
              )}
            </div>
          </section>

          <aside className="dashboard-side">
            <div className="dashboard-card side-card">
              <div className="side-label">Total tokens</div>
              <div className="side-value">{fmtTokens(stats?.totalTokens ?? 0)}</div>
              {stats && stats.totalTokens > 0 ? (
                <div className="side-delta">
                  peak {fmtTokens(stats.peakTokens)} · {stats.activeDays} active day
                  {stats.activeDays === 1 ? '' : 's'}
                </div>
              ) : null}
              {spec.kind !== 'donut' && <SideBars values={spec.totals} />}
            </div>
            <div className="dashboard-card side-card">
              <div className="side-label">By model</div>
              <div className="mt-[7px]">
                {spec.shares.length > 0 ? (
                  spec.shares.map((share) => (
                    <div className="model-row" key={share.name}>
                      <i style={{ background: share.color }} />
                      <span>{share.name}</span>
                      <b>{Math.round(share.percent)}%</b>
                    </div>
                  ))
                ) : (
                  <div className="py-1 font-mono text-[0.5rem] uppercase tracking-[0.1em] text-muted-foreground/50">
                    No usage yet
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-4 flex items-center gap-2 px-1 font-mono text-[0.65rem] text-muted-foreground/55">
          <span className="tracking-[0.1em]">READOUT</span>
          <span className="h-px flex-1 bg-border/50" />
        </div>
        <p className="px-1 pt-2 text-[0.78rem] leading-relaxed text-muted-foreground">{readout}</p>

        <div className="gallery-head">
          <h2>Charts</h2>
          <span>3 views</span>
          <span className="spacer" />
          <Button type="button" variant="bare" className="ghost-button" onClick={() => void navigate('/artifacts')}>
            View all <SignalIcon name="chev-right" />
          </Button>
        </div>
        <div className="gallery-grid">
          {(['tokens', 'activity', 'models'] as ChartViewKey[]).map((key) => {
            const item = specs[key];
            const selected = key === viewKey;
            return (
              <Button
                key={key}
                type="button"
                variant="bare"
                className="gallery-card"
                data-active={selected || undefined}
                onClick={() => selectView(item)}
                aria-pressed={selected}
              >
                <span className="gallery-visual">
                  {item.kind === 'donut' ? (
                    <MiniDonut shares={item.shares} />
                  ) : item.defaultMode === 'bars' ? (
                    <MiniBars values={item.totals} color={C1} />
                  ) : (
                    <MiniLine series={item.series} />
                  )}
                </span>
                <span className="gallery-meta block">
                  <span className="gallery-name block">{item.title}</span>
                  <span className="gallery-kind block">
                    {item.kind === 'donut'
                      ? `DONUT · ${item.shares.length || 0} MODELS · ${range.toUpperCase()}`
                      : `${item.defaultMode.toUpperCase()} · ${totalDays} DAYS · ${range.toUpperCase()}`}
                  </span>
                </span>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
