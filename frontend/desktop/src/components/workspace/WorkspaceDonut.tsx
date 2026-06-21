/* ── WorkspaceDonut — SVG donut chart for the Model-usage view ──────── */
/* Pure SVG. Slices are computed from cumulative offsets so the chart
 * scales gracefully for any number of segments. Palette lifted from the
 * legacy Usage.tsx for visual parity with the screenshot. */

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

export function WorkspaceDonut({
  slices,
  centerLabel,
  centerSub = 'tokens',
  legendLimit = 6,
  className,
  formatValue,
}: Props) {
  const R = 36;
  const STROKE = 14;
  const C = 2 * Math.PI * R;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  let offset = 0;
  const visible = slices.slice(0, legendLimit);

  return (
    <div className={cn('flex items-center gap-6', className)}>
      <svg viewBox="0 0 96 96" className="size-32 shrink-0">
        <g transform="rotate(-90 48 48)">
          {visible.map((s, i) => {
            const len = (s.value / total) * C;
            const dash = `${len} ${C - len}`;
            const off = -offset;
            offset += len;
            const color = s.color ?? modelColor(s.label);
            return (
              <circle
                key={s.label + i}
                cx="48"
                cy="48"
                r={R}
                fill="none"
                stroke={color}
                strokeWidth={STROKE}
                strokeDasharray={dash}
                strokeDashoffset={off}
              />
            );
          })}
        </g>
        <text
          x="48"
          y="48"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-white"
          style={{ fontSize: 13, fontWeight: 600 }}
        >
          {centerLabel ?? total.toLocaleString()}
        </text>
        <text
          x="48"
          y="62"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-white/70"
          style={{ fontSize: 7 }}
        >
          {centerSub}
        </text>
      </svg>

      <div className="flex-1 min-w-0 space-y-1.5">
        {visible.map((s, i) => {
          const color = s.color ?? modelColor(s.label);
          return (
            <div key={s.label + i} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="flex-1 truncate text-foreground">{s.label}</span>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {formatValue ? formatValue(s.value) : s.value.toLocaleString()}
              </span>
              <span className="text-muted-foreground tabular-nums shrink-0 w-12 text-right">
                {s.percent.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
