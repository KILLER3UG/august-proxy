/* eslint-disable react-refresh/only-export-components */

/* ── WorkspaceDonut — SVG donut chart for the Model-usage view ──────── */
/* Pure SVG. Slices use cumulative offsets so the chart scales for any
 * number of segments. */

import { cn } from '@/lib/utils';

export interface DonutSlice {
  label: string;
  value: number;
  percent: number;
  color?: string;
}

export const DEFAULT_COLORS = [
  '#3b7eff',
  '#4ade80',
  '#f59e0b',
  '#f87171',
  '#a78bfa',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

const COLOR_CACHE = new Map<string, string>();
/**
 * Stable model → color mapping. Same model always renders in the same
 * color across the donut and the Tokens-per-day chart, so the legend
 * matches the bar segments. Tolerates undefined / null / non-string
 * inputs by falling back to a default color.
 */
export function modelColor(model: unknown): string {
  const key = typeof model === 'string' ? model : '';
  if (COLOR_CACHE.has(key)) return COLOR_CACHE.get(key)!;
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  const color = DEFAULT_COLORS[Math.abs(hash) % DEFAULT_COLORS.length];
  COLOR_CACHE.set(key, color);
  return color;
}

interface Props {
  slices: DonutSlice[];
  /** Center label for the donut. */
  centerLabel?: string;
  centerSub?: string;
  /** Max slices to show in the legend. Default 6. */
  legendLimit?: number;
  className?: string;
  /** Format function for the right-hand number column. */
  formatValue?: (v: number) => string;
}

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
  return tokens.toLocaleString();
}

export function WorkspaceDonut({
  slices,
  centerLabel,
  centerSub = 'tokens',
  legendLimit = 6,
  className,
  formatValue,
}: Props) {
  const R = 42;
  const STROKE = 18;
  const C = 2 * Math.PI * R;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  let offset = 0;
  const visible = slices.slice(0, legendLimit);

  return (
    <div className={cn('flex flex-col md:flex-row items-center gap-8 py-2', className)}>
      <div className="relative shrink-0">
        <svg viewBox="0 0 120 120" className="size-48">
          <g transform="rotate(-90 60 60)">
            {visible.map((s, i) => {
              const len = (s.value / total) * C;
              const dash = `${len} ${C - len}`;
              const off = -offset;
              offset += len;
              const color = s.color ?? modelColor(s.label);
              return (
                <circle
                  key={s.label + i}
                  cx="60"
                  cy="60"
                  r={R}
                  fill="none"
                  stroke={color}
                  strokeWidth={STROKE}
                  strokeDasharray={dash}
                  strokeDashoffset={off}
                  className="transition-all hover:opacity-80"
                />
              );
            })}
          </g>
          <text
            x="60"
            y="56"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-white"
            style={{ fontSize: 16, fontWeight: 700 }}
          >
            {centerLabel ?? formatShortTokens(total)}
          </text>
          <text
            x="60"
            y="72"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-muted-foreground/80"
            style={{ fontSize: 10 }}
          >
            {centerSub}
          </text>
        </svg>
      </div>

      <div className="flex-1 w-full min-w-0 space-y-3">
        {visible.map((s, i) => {
          const color = s.color ?? modelColor(s.label);
          const formattedVal = formatValue
            ? formatValue(s.value)
            : `${formatShortTokens(s.value)} tokens`;
          return (
            <div key={s.label + i} className="flex items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11.5px] text-foreground">{s.label}</div>
                  <div className="text-[10.5px] text-muted-foreground/70">{formattedVal}</div>
                </div>
              </div>
              <span className="text-muted-foreground/80 font-mono text-xs tabular-nums shrink-0">
                {s.percent.toFixed(s.percent < 10 && s.percent % 1 !== 0 ? 1 : 0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
