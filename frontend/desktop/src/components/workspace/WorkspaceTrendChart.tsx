/* ── WorkspaceTrendChart — Smooth SVG multi-line trend chart ─────────── */
/* Renders smooth bezier splines for each model, with an interactive hover
 * tooltip showing per-model token breakdown for any hovered day. */

import { useMemo, useState, useRef } from 'react';
import { cn } from '@/lib/utils';
import { modelColor } from './WorkspaceDonut';

export interface DailyModelData {
  date: string; // YYYY-MM-DD
  tokens: number;
  models: { model: string; tokens: number }[];
}

interface Props {
  data: DailyModelData[];
  className?: string;
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

function formatDateLabel(dateStr: string): string {
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  } catch {
    // fallback
  }
  return dateStr;
}

/** Compute smooth SVG cubic bezier path through 2D points */
function getSplinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1] : points[0];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i < points.length - 2 ? points[i + 2] : p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function WorkspaceTrendChart({ data, className }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Extract unique model list across all days
  const allModels = useMemo(() => {
    const set = new Set<string>();
    for (const d of data) {
      for (const m of d.models) {
        if (m.tokens > 0) set.add(m.model);
      }
    }
    return Array.from(set);
  }, [data]);

  // Find max value for Y scaling
  const maxTokenVal = useMemo(() => {
    let m = 1;
    for (const d of data) {
      for (const model of d.models) {
        if (model.tokens > m) m = model.tokens;
      }
      if (d.tokens > m) m = d.tokens;
    }
    return m * 1.15; // 15% headroom
  }, [data]);

  const W = 800;
  const H = 200;
  const PAD_LEFT = 20;
  const PAD_RIGHT = 20;
  const PAD_TOP = 20;
  const PAD_BOTTOM = 30;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const pointsByModel = useMemo(() => {
    if (data.length === 0) return {};
    const map: Record<string, { x: number; y: number; tokens: number }[]> = {};
    for (const model of allModels) {
      map[model] = [];
    }

    data.forEach((day, i) => {
      const x = data.length === 1 ? W / 2 : PAD_LEFT + (i / (data.length - 1)) * innerW;
      const modelMap = new Map<string, number>();
      for (const m of day.models) {
        modelMap.set(m.model, m.tokens);
      }

      for (const model of allModels) {
        const tokens = modelMap.get(model) ?? 0;
        const normY = maxTokenVal > 0 ? tokens / maxTokenVal : 0;
        const y = PAD_TOP + innerH - normY * innerH;
        map[model].push({ x, y, tokens });
      }
    });
    return map;
  }, [data, allModels, innerW, innerH, maxTokenVal]);

  const activeDay = hoverIndex !== null && data[hoverIndex] ? data[hoverIndex] : null;

  return (
    <div className={cn('space-y-4', className)} ref={containerRef}>
      {/* Model legend in chart header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px]">
        {allModels.map((model) => (
          <div key={model} className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: modelColor(model) }}
            />
            <span className="font-mono text-xs">{model}</span>
          </div>
        ))}
      </div>

      <div className="relative w-full overflow-visible select-none">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto overflow-visible"
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* Subtle horizontal gridlines */}
          {[0, 0.33, 0.66, 1].map((pct, i) => {
            const y = PAD_TOP + innerH - pct * innerH;
            return (
              <line
                key={i}
                x1={PAD_LEFT}
                x2={W - PAD_RIGHT}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.07}
                strokeDasharray="4 4"
              />
            );
          })}

          {/* Model spline lines */}
          {allModels.map((model) => {
            const pts = pointsByModel[model] ?? [];
            const pathD = getSplinePath(pts);
            const color = modelColor(model);
            return (
              <g key={model}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-opacity duration-150"
                  opacity={hoverIndex !== null ? 0.85 : 0.95}
                />
              </g>
            );
          })}

          {/* Vertical hover line & glowing dots */}
          {hoverIndex !== null && (
            (() => {
              const x =
                data.length === 1
                  ? W / 2
                  : PAD_LEFT + (hoverIndex / (data.length - 1)) * innerW;
              return (
                <g className="pointer-events-none">
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD_TOP}
                    y2={H - PAD_BOTTOM}
                    stroke="white"
                    strokeOpacity={0.25}
                    strokeDasharray="3 3"
                  />
                  {allModels.map((model) => {
                    const pt = pointsByModel[model]?.[hoverIndex];
                    if (!pt || pt.tokens <= 0) return null;
                    const color = modelColor(model);
                    return (
                      <g key={model}>
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r="5"
                          fill={color}
                          stroke="#18181b"
                          strokeWidth="2"
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })()
          )}

          {/* Date labels on bottom axis */}
          {data.map((d, i) => {
            const x =
              data.length === 1
                ? W / 2
                : PAD_LEFT + (i / (data.length - 1)) * innerW;
            const isHovered = hoverIndex === i;
            return (
              <text
                key={d.date}
                x={x}
                y={H - 8}
                textAnchor="middle"
                className={cn(
                  'text-[10px] transition-colors',
                  isHovered ? 'fill-foreground font-semibold' : 'fill-muted-foreground/70',
                )}
              >
                {formatDateLabel(d.date)}
              </text>
            );
          })}

          {/* Invisible interactive column hitboxes for smooth hover tracking */}
          {data.map((_, i) => {
            const colW = innerW / Math.max(1, data.length - 1);
            const x =
              data.length === 1
                ? PAD_LEFT
                : PAD_LEFT + i * colW - colW / 2;
            return (
              <rect
                key={i}
                x={Math.max(0, x)}
                y={0}
                width={colW}
                height={H}
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHoverIndex(i)}
              />
            );
          })}
        </svg>

        {/* Floating tooltip popover matching Image 5 */}
        {activeDay && hoverIndex !== null && (
          <div
            className="absolute z-20 pointer-events-none rounded-xl border border-white/[0.12] bg-[#1a1c20]/95 backdrop-blur-md p-3.5 shadow-2xl transition-all duration-75 text-xs"
            style={{
              left: `${Math.min(
                Math.max(10, (hoverIndex / Math.max(1, data.length - 1)) * 100),
                75,
              )}%`,
              top: '15px',
              minWidth: '220px',
            }}
          >
            <div className="font-semibold text-foreground pb-2 mb-2 border-b border-white/[0.08]">
              {formatDateLabel(activeDay.date)} - {formatShortTokens(activeDay.tokens)} tokens
            </div>
            <div className="space-y-1.5">
              {activeDay.models
                .filter((m) => m.tokens > 0)
                .map((m) => (
                  <div key={m.model} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{ backgroundColor: modelColor(m.model) }}
                      />
                      <span className="truncate text-muted-foreground font-mono text-[11px]">
                        {m.model}
                      </span>
                    </div>
                    <span className="font-medium tabular-nums text-foreground/90 shrink-0">
                      {formatShortTokens(m.tokens)} tokens
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
