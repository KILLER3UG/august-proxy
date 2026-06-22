/* ── WorkspaceHeatmap — GitHub-style activity heatmap ────────────────── */
/* Pure CSS. 5-row layout so the calendar reads like a week column. Lifted
 * from the legacy Usage.tsx so visual parity is preserved. */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  count: number;
}

interface Props {
  cells: HeatmapCell[];
  className?: string;
  /** Show the Less → More intensity legend. Defaults to true. */
  legend?: boolean;
}

const LEVELS = [
  'bg-white/[0.025]',
  'bg-success/40',
  'bg-success/60',
  'bg-success/80',
  'bg-success',
];

function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

export function WorkspaceHeatmap({ cells, className, legend = true }: Props) {
  const max = useMemo(() => Math.max(0, ...cells.map((c) => c.count)), [cells]);

  // Reshape into a 5-row grid; columns flow top-to-bottom then left-to-right.
  const cols = Math.ceil(cells.length / 5);
  const grid: HeatmapCell[][] = Array.from({ length: 5 }, () => []);
  cells.forEach((cell, i) => grid[Math.floor(i / 5)].push(cell));

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex gap-[2px] overflow-x-auto pb-1">
        {grid.map((row, r) => (
          <div key={r} className="flex flex-col gap-[2px] shrink-0">
            {row.map((cell) => {
              const level = intensity(cell.count, max);
              return (
                <div
                  key={cell.date}
                  title={`${cell.date}: ${cell.count.toLocaleString()}`}
                  className={cn('size-[9px] rounded-[2px]', LEVELS[level])}
                />
              );
            })}
          </div>
        ))}
      </div>
      {legend && (
        <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
          <span>Less</span>
          <div className="flex gap-[2px]">
            {LEVELS.map((cls, i) => (
              <div key={i} className={cn('size-[9px] rounded-[2px]', cls)} />
            ))}
          </div>
          <span>More</span>
        </div>
      )}
    </div>
  );
}
