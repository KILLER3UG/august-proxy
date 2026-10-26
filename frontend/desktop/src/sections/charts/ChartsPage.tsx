/* ── Charts — the Signal Desk chart surface ────────────────────────────
 *
 * Phase 3 of the Signal Desk port. The mockup's Charts screen is a designed
 * sample (its data is illustrative); this page carries that sample so the
 * surface, hierarchy and interactions are real while the chart library
 * backend does not exist. The chart renderer itself is pure SVG and uses the
 * paired --dt-chart-* tokens, so it works in light and dark from one source.
 *
 * When the chart artifact store lands, the CHART_DEFS fixture below is the
 * only thing that should be replaced: the cards, plot, metrics and readout
 * consume a ChartDef and nothing else.
 */

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Copy, Download, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import { dispatchInsertComposerText } from '@/api/ui-events';
import { createSession } from '@/store/sessions';
import { copyFigurePng, downloadFigurePng } from '@/lib/svg-figure';
import { cn } from '@/lib/utils';

type ChartMode = 'line' | 'area' | 'bars';
type ChartKind = 'series' | 'donut';

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

interface ChartDef {
  key: string;
  title: string;
  meta: string;
  kind: ChartKind;
  total: string;
  totalLabel: string;
  peak: string;
  peakLabel: string;
  models: string;
  modelsLabel: string;
  labels: string[];
  yLabels: string[];
  /** Explicit axis maximum: keeps the plotted geometry and the printed
   *  ticks on the same scale. */
  yMax?: number;
  series: Series[];
  shares: Share[];
  defaultMode: ChartMode;
  highlight?: { index: number; label: string; value: string; note: string };
  readout: string;
  ticker: string;
}

const C1 = 'var(--dt-chart-1)';
const C2 = 'var(--dt-chart-2)';
const C3 = 'var(--dt-chart-3)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const CHART_DEFS: ChartDef[] = [
  {
    key: 'token-burn',
    title: 'Token burn — weekly',
    meta: '3 models · 30 days · last rendered 2m ago',
    kind: 'series',
    total: '18.4M',
    totalLabel: 'Total tokens',
    peak: '4.2M',
    peakLabel: 'Peak day',
    models: '03',
    modelsLabel: 'Models',
    labels: ['Apr 01', 'Apr 08', 'Apr 15', 'Apr 22', '30'],
    yLabels: ['6M', '4.5M', '3M', '1.5M', '0'],
    yMax: 6,
    series: [
      { name: 'deepseek-v4-flash', color: C1, values: [0.8, 1.0, 1.2, 1.3, 4.2, 1.5, 1.7, 2.0, 2.4, 2.9] },
      { name: 'qwen3.8', color: C2, values: [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5] },
      { name: 'claude-sonnet', color: C3, values: [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65] },
    ],
    shares: [
      { name: 'deepseek-v4-flash', color: C1, percent: 71 },
      { name: 'qwen3.8', color: C2, percent: 21 },
      { name: 'claude-sonnet', color: C3, percent: 8 },
    ],
    defaultMode: 'line',
    highlight: { index: 4, label: 'TUE · APR 16', value: '4.2M tokens', note: 'deepseek +3.8×' },
    readout:
      'Tuesday was not a broad jump. deepseek accounted for 86% of the delta; qwen and claude stayed inside their 7-day range.',
    ticker: 'TOKENS',
  },
  {
    key: 'cost-provider',
    title: 'Cost by provider',
    meta: '3 providers · month to date · last rendered 5h ago',
    kind: 'series',
    total: '$82.40',
    totalLabel: 'Total spend',
    peak: '$21.10',
    peakLabel: 'Peak day',
    models: '03',
    modelsLabel: 'Providers',
    labels: ['Apr 01', 'Apr 08', 'Apr 15', 'Apr 22', '30'],
    yLabels: ['$30', '$20', '$10', '$0'],
    yMax: 30,
    series: [
      { name: 'deepseek', color: C1, values: [11, 14, 13, 18, 16, 21, 19, 17, 20, 18] },
      { name: 'qwen3.8', color: C2, values: [4, 5, 6, 7, 8, 9, 8, 7, 9, 8] },
      { name: 'anthropic', color: C3, values: [2, 3, 3, 4, 4, 5, 4, 3, 5, 4] },
    ],
    shares: [
      { name: 'deepseek', color: C1, percent: 55 },
      { name: 'qwen3.8', color: C2, percent: 28 },
      { name: 'anthropic', color: C3, percent: 17 },
    ],
    defaultMode: 'bars',
    highlight: { index: 5, label: 'APR 16', value: '$21.10', note: 'deepseek 73%' },
    readout:
      'Spend tracks tokens but not exactly. The Tuesday spike costs 3.8× the normal day, while qwen’s cost per 1k stays flat.',
    ticker: 'USD',
  },
  {
    key: 'context-allocation',
    title: 'Context allocation',
    meta: '3 slices · live · windows by model',
    kind: 'donut',
    total: '128k',
    totalLabel: 'Window',
    peak: '96%',
    peakLabel: 'Peak fill',
    models: '03',
    modelsLabel: 'Models',
    labels: [],
    yLabels: [],
    series: [
      { name: 'deepseek-v4-flash', color: C1, values: [71] },
      { name: 'qwen3.8', color: C2, values: [21] },
      { name: 'claude-sonnet', color: C3, values: [8] },
    ],
    shares: [
      { name: 'deepseek-v4-flash', color: C1, percent: 71 },
      { name: 'qwen3.8', color: C2, percent: 21 },
      { name: 'claude-sonnet', color: C3, percent: 8 },
    ],
    defaultMode: 'line',
    readout:
      'The window is 71% deepseek because its 128k budget is the one being filled; qwen and claude are comparison runs.',
    ticker: 'TOKENS',
  },
  {
    key: 'latency-model',
    title: 'Latency by model',
    meta: '2 models · 7 days · last rendered 1d ago',
    kind: 'series',
    total: '420ms',
    totalLabel: 'Median',
    peak: '1.2s',
    peakLabel: 'Worst',
    models: '02',
    modelsLabel: 'Models',
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    yLabels: ['1.2s', '800ms', '400ms', '0'],
    yMax: 1200,
    series: [
      { name: 'qwen3.8', color: C1, values: [420, 380, 450, 410, 390, 440, 430] },
      { name: 'deepseek-v4-flash', color: C2, values: [600, 550, 680, 620, 590, 700, 660] },
    ],
    shares: [
      { name: 'qwen3.8', color: C1, percent: 52 },
      { name: 'deepseek-v4-flash', color: C2, percent: 48 },
    ],
    defaultMode: 'line',
    highlight: { index: 2, label: 'WED', value: '680ms', note: 'deepseek' },
    readout:
      'Latency is tight for both models. Wednesday is the only day above the 600ms band, and it clears by Thursday.',
    ticker: 'MS',
  },
];

const PLOT = { width: 760, height: 300, left: 46, right: 16, top: 18, bottom: 30 };

function xAt(index: number, count: number): number {
  if (count <= 1) return PLOT.left;
  return PLOT.left + (index * (PLOT.width - PLOT.left - PLOT.right)) / (count - 1);
}

function yAt(value: number, max: number): number {
  return PLOT.top + (1 - value / max) * (PLOT.height - PLOT.top - PLOT.bottom);
}

function seriesMax(chart: ChartDef): number {
  return Math.max(...chart.series.flatMap((s) => s.values), 0.001);
}

function SeriesChart({ chart, mode }: { chart: ChartDef; mode: ChartMode }) {
  const max = chart.yMax ?? seriesMax(chart) * 1.08;
  const count = chart.series[0]?.values.length ?? 0;
  const baseline = PLOT.height - PLOT.bottom;
  const groups = chart.series.length;

  return (
    <svg
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      role="img"
      aria-label={`${chart.title} chart`}
      className="block h-auto w-full"
    >
      <g stroke="var(--dt-border)" strokeWidth="1">
        {chart.yLabels.map((_, index) => {
          const y = PLOT.top + (index * (PLOT.height - PLOT.top - PLOT.bottom)) / (chart.yLabels.length - 1);
          return <line key={index} x1={PLOT.left} y1={y} x2={PLOT.width - PLOT.right} y2={y} />;
        })}
      </g>
      <g fontFamily={MONO} fontSize="9" fill="var(--dt-muted-foreground)">
        {chart.yLabels.map((label, index) => {
          const y = PLOT.top + (index * (PLOT.height - PLOT.top - PLOT.bottom)) / (chart.yLabels.length - 1);
          return (
            <text key={label} x={8} y={y + 3}>
              {label}
            </text>
          );
        })}
        {chart.labels.map((label, index) => {
          const x = xAt(index, chart.labels.length);
          const anchor = index === 0 ? 'start' : index === chart.labels.length - 1 ? 'end' : 'middle';
          return (
            <text key={label} x={x} y={PLOT.height - 8} textAnchor={anchor}>
              {label}
            </text>
          );
        })}
      </g>

      {mode === 'bars'
        ? chart.series.map((series, seriesIndex) => {
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
        : chart.series.map((series, index) => {
            const points = series.values.map((value, pointIndex) => ({
              x: xAt(pointIndex, count),
              y: yAt(value, max),
            }));
            const line = points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
            return (
              <g key={series.name}>
                {mode === 'area' && (
                  <path
                    d={`${line} L${points[points.length - 1].x.toFixed(1)} ${baseline} L${points[0].x.toFixed(1)} ${baseline} Z`}
                    fill={series.color}
                    opacity={index === 0 ? 0.16 : 0.08}
                  />
                )}
                <path d={line} fill="none" stroke={series.color} strokeWidth={index === 0 ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round" opacity={index === 0 ? 1 : 0.85} />
              </g>
            );
          })}

      {chart.highlight && (
        <g>
          <line
            x1={xAt(chart.highlight.index, count)}
            y1={PLOT.top}
            x2={xAt(chart.highlight.index, count)}
            y2={baseline}
            stroke="var(--dt-muted-foreground)"
            strokeDasharray="3 5"
            opacity="0.55"
          />
          {chart.series.map((series, index) => (
            <circle
              key={series.name}
              cx={xAt(chart.highlight!.index, count)}
              cy={yAt(series.values[chart.highlight!.index] ?? 0, max)}
              r={index === 0 ? 4 : 3}
              fill={series.color}
              stroke="var(--dt-background)"
              strokeWidth="2"
            />
          ))}
          <g transform={`translate(${Math.min(xAt(chart.highlight.index, count) + 12, PLOT.width - 170)} ${PLOT.top + 6})`}>
            <rect width="156" height="54" rx="6" fill="var(--dt-popover)" stroke="var(--dt-border)" />
            <text x="10" y="16" fontFamily={MONO} fontSize="8" fill="var(--dt-muted-foreground)">{chart.highlight.label}</text>
            <text x="10" y="31" fontFamily={MONO} fontSize="12" fill="var(--dt-foreground)">{chart.highlight.value}</text>
            <text x="10" y="45" fontFamily={MONO} fontSize="8" fill={chart.series[0].color}>{chart.highlight.note}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

function DonutChart({ chart }: { chart: ChartDef }) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-8 sm:flex-row sm:gap-10">
      <svg viewBox="0 0 220 220" role="img" aria-label={`${chart.title} donut chart`} className="size-[220px]">
        <circle cx="110" cy="110" r={radius} fill="none" stroke="var(--dt-muted)" strokeWidth="22" />
        {chart.series.map((series) => {
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
        <text x="110" y="104" textAnchor="middle" fontFamily={MONO} fontSize="9" fill="var(--dt-muted-foreground)">WINDOW</text>
        <text x="110" y="128" textAnchor="middle" fontFamily={MONO} fontSize="20" fill="var(--dt-foreground)">{chart.total}</text>
      </svg>
      <div className="w-full max-w-[220px] space-y-2.5">
        {chart.shares.map((share) => (
          <div key={share.name} className="flex items-center gap-2 text-[0.78rem]">
            <svg className="size-2 shrink-0" viewBox="0 0 8 8" aria-hidden="true">
              <circle cx="4" cy="4" r="4" fill={share.color} />
            </svg>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{share.name}</span>
            <span className="font-mono text-[0.7rem] text-foreground/80">{share.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChart({ chart }: { chart: ChartDef }) {
  if (chart.kind === 'donut') {
    return (
      <svg viewBox="0 0 44 26" className="h-[26px] w-11" aria-hidden="true">
        <circle cx="22" cy="13" r="8" fill="none" stroke="var(--dt-muted)" strokeWidth="4" />
        <circle cx="22" cy="13" r="8" fill="none" stroke={C1} strokeWidth="4" strokeDasharray="28 52" transform="rotate(-90 22 13)" />
        <circle cx="22" cy="13" r="8" fill="none" stroke={C3} strokeWidth="4" strokeDasharray="12 52" strokeDashoffset="-28" transform="rotate(-90 22 13)" />
      </svg>
    );
  }
  const values = chart.series[0]?.values ?? [];
  const max = Math.max(...values, 0.001);
  const points = values.map((value, index) => `${3 + (index * 38) / Math.max(values.length - 1, 1)} ${22 - (value / max) * 16}`).join(' L');
  return (
    <svg viewBox="0 0 44 26" className="h-[26px] w-11" aria-hidden="true">
      <path d="M0 21h44M0 13h44" stroke="var(--dt-border)" />
      <path d={`M${points}`} fill="none" stroke={chart.series[0]?.color ?? C1} strokeWidth="1.4" />
    </svg>
  );
}

function ChartCard({ chart, selected, onSelect }: { chart: ChartDef; selected: boolean; onSelect: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className={cn(
        'group h-auto w-full flex-col items-start justify-start gap-0 rounded-xl border p-3 text-left font-normal whitespace-normal transition-colors',
        selected
          ? 'border-primary/40 bg-card/60'
          : 'border-border/50 bg-card/25 hover:border-border hover:bg-card/50',
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <MiniChart chart={chart} />
        <ArrowUpRight className="size-3 text-muted-foreground/40 group-hover:text-muted-foreground" />
      </span>
      <span className="mt-2 block truncate text-[0.8rem] font-medium text-foreground/90">{chart.title}</span>
      <span className="mt-0.5 block truncate font-mono text-[0.6rem] uppercase tracking-[0.06em] text-muted-foreground/55">
        {chart.ticker} · {chart.kind === 'donut' ? '3 slices' : `${chart.series.length} series`}
      </span>
    </Button>
  );
}

export function ChartsPage() {
  const navigate = useNavigate();
  const [selectedKey, setSelectedKey] = useState(CHART_DEFS[0].key);
  const [mode, setMode] = useState<ChartMode>(CHART_DEFS[0].defaultMode);
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chart = useMemo(
    () => CHART_DEFS.find((item) => item.key === selectedKey) ?? CHART_DEFS[0],
    [selectedKey],
  );

  const selectChart = (next: ChartDef) => {
    setSelectedKey(next.key);
    setMode(next.defaultMode);
  };

  const chartSvg = () => chartHostRef.current?.querySelector('svg') as SVGSVGElement | null;
  const downloadChart = () => {
    const svg = chartSvg();
    if (!svg) return;
    void downloadFigurePng(svg, chart.title)
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

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-8 py-8">
      <SectionHeader
        title="Charts"
        subtitle="Every chart August has rendered, with the data and the reasoning still attached."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => seed('Analyze this dataset. I will attach the file next.')}
            >
              <Upload className="size-3.5" />
              Import data
            </Button>
            <Button type="button" size="sm" onClick={() => seed('Create a chart showing ')}>
              <Plus className="size-3.5" />
              New chart
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_272px]">
        <section className="min-w-0 rounded-2xl border border-border/55 bg-card/30 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3 px-1 pb-3">
            <div>
              <h2 className="text-[0.95rem] font-medium text-foreground">{chart.title}</h2>
              <p className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground/55">{chart.meta}</p>
            </div>
            {chart.kind === 'series' && (
              <div className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5" role="tablist" aria-label="Chart shape">
                {(['line', 'area', 'bars'] as ChartMode[]).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={mode === item}
                    variant="ghost"
                    size="sm"
                    onClick={() => setMode(item)}
                    className={cn(
                      'h-6 rounded-md px-2 text-[0.65rem] capitalize',
                      mode === item ? 'bg-muted text-foreground' : 'text-muted-foreground/60',
                    )}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground/60"
                onClick={downloadChart}
                title="Download chart as PNG"
                aria-label="Download chart as PNG"
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground/60"
                onClick={copyChart}
                title="Copy chart as image"
                aria-label="Copy chart as image"
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>
          <div ref={chartHostRef} className="px-1">
            {chart.kind === 'donut' ? <DonutChart chart={chart} /> : <SeriesChart chart={chart} mode={mode} />}
          </div>
          <div className="mt-4 flex items-center gap-2 px-1 font-mono text-[0.65rem] text-muted-foreground/55">
            <span className="tracking-[0.1em]">READOUT</span>
            <span className="h-px flex-1 bg-border/50" />
          </div>
          <p className="px-1 pt-2 text-[0.78rem] leading-relaxed text-muted-foreground">{chart.readout}</p>
        </section>

        <aside className="space-y-3">
          <div className="rounded-2xl border border-border/55 bg-card/30 p-4">
            <div className="grid grid-cols-3 gap-3 border-b border-border/40 pb-3">
              {[
                [chart.totalLabel, chart.total],
                [chart.peakLabel, chart.peak],
                [chart.modelsLabel, chart.models],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="font-mono text-[0.58rem] uppercase tracking-[0.1em] text-muted-foreground/45">{label}</div>
                  <div className="mt-1 font-mono text-[0.9rem] text-foreground">{value}</div>
                </div>
              ))}
            </div>
            {chart.kind !== 'donut' && (
            <svg viewBox="0 0 220 40" className="mt-3 h-10 w-full" preserveAspectRatio="none" aria-hidden="true">
              {(chart.series[0]?.values ?? []).map((value, index, values) => {
                const max = seriesMax(chart);
                const gap = 4;
                const width = (220 - gap * (values.length - 1)) / Math.max(values.length, 1);
                const height = Math.max(3, (value / max) * 40);
                return (
                  <rect
                    key={index}
                    x={index * (width + gap)}
                    y={40 - height}
                    width={width}
                    height={height}
                    rx="1.5"
                    fill="var(--dt-primary)"
                    opacity="0.6"
                  />
                );
              })}
            </svg>
            )}
            <div className="mt-4 space-y-2">
              {chart.shares.map((share) => (
                <div key={share.name} className="flex items-center gap-2 text-[0.72rem]">
                  <svg className="size-1.5 shrink-0" viewBox="0 0 6 6" aria-hidden="true">
                    <circle cx="3" cy="3" r="3" fill={share.color} />
                  </svg>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{share.name}</span>
                  <span className="font-mono text-[0.62rem] text-muted-foreground/65">{share.percent}%</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[0.82rem] font-medium text-foreground/80">Recent charts</h2>
          <Button type="button" variant="ghost" size="sm" className="text-[0.7rem] text-muted-foreground/60" onClick={() => void navigate('/artifacts')}>
            View all
            <ArrowUpRight className="size-3" />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {CHART_DEFS.map((item) => (
            <ChartCard
              key={item.key}
              chart={item}
              selected={item.key === chart.key}
              onSelect={() => selectChart(item)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
