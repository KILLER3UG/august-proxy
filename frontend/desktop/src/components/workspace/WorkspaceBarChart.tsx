/* ── WorkspaceBarChart — Tokens-per-day bar chart ────────────────────── */
/* Pure SVG. Auto-scales Y axis. Renders one bar per day; the chart pads
 * to the requested range so short ranges don't get stretched. */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface BarPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

interface Props {
  bars: BarPoint[];
  /** Tooltip label. Default "tokens". */
  unit?: string;
  /** Format function for the Y-axis / value labels. */
  formatValue?: (v: number) => string;
  className?: string;
}

export function WorkspaceBarChart({ bars, unit = 'tokens', formatValue, className }: Props) {
  const { max, total } = useMemo(() => {
    const values = bars.map((b) => b.value);
    return {
      max: Math.max(0, ...values, 1),
      total: values.reduce((a, b) => a + b, 0),
    };
  }, [bars]);

  const fmt = formatValue ?? ((v: number) => v.toLocaleString());

  // SVG viewbox: 100% wide; bars are uniform width with small gap
  const W = 800;
  const H = 220;
  const PAD_X = 16;
  const PAD_TOP = 24;
  const PAD_BOTTOM = 28;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const gap = bars.length > 30 ? 1 : bars.length > 14 ? 2 : 4;
  const barW = Math.max(1, innerW / bars.length - gap);

  // Y-axis ticks: 4 evenly-spaced gridlines
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(max * p));

  // X-axis date labels: pick every Nth bar so labels don't overlap
  const labelEvery = Math.max(1, Math.ceil(bars.length / 8));

  return (
    <div className={cn('w-full', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        {/* Gridlines + Y-axis labels */}
        {ticks.map((t, i) => {
          const y = PAD_TOP + innerH - (t / max) * innerH;
          return (
            <g key={i}>
              <line
                x1={PAD_X}
                x2={W - PAD_X}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.06}
                strokeDasharray={i === 0 ? '0' : '3 3'}
              />
              <text
                x={W - PAD_X - 4}
                y={y - 2}
                textAnchor="end"
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {fmt(t)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {bars.map((b, i) => {
          const x = PAD_X + i * (barW + gap);
          const h = (b.value / max) * innerH;
          const y = PAD_TOP + innerH - h;
          return (
            <rect
              key={b.date}
              x={x}
              y={y}
              width={barW}
              height={Math.max(0, h)}
              rx={1.5}
              fill="#3b7eff"
              fillOpacity={b.value === 0 ? 0.15 : 0.85}
            >
              <title>{`${b.date}: ${fmt(b.value)} ${unit}`}</title>
            </rect>
          );
        })}

        {/* X-axis date labels */}
        {bars.map((b, i) => {
          if (i % labelEvery !== 0 && i !== bars.length - 1) return null;
          const x = PAD_X + i * (barW + gap) + barW / 2;
          return (
            <text
              key={`x-${b.date}`}
              x={x}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {b.date.slice(5)}
            </text>
          );
        })}
      </svg>
      <div className="mt-2 text-xs text-muted-foreground">
        Total {fmt(total)} {unit} across {bars.length} days.
      </div>
    </div>
  );
}
