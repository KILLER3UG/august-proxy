/* ── WorkspaceHeatmap — GitHub-style activity heatmap ────────────────── */
/* Pure CSS. 5-row layout so the calendar reads like a week column. */

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
  'bg-white/[0.035] border border-white/[0.02]',
  'bg-blue-900/60 border border-blue-800/40 text-blue-300',
  'bg-blue-700/80 border border-blue-600/50 text-blue-200',
  'bg-blue-600 border border-blue-500/60 text-white',
  'bg-blue-500 border border-blue-400 text-white shadow-sm shadow-blue-500/30',
];

function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

const MONTH_NAMES = ['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

export function WorkspaceHeatmap({ cells, className, legend = true }: Props) {
  const max = useMemo(() => Math.max(0, ...cells.map((c) => c.count)), [cells]);

  // Generate 52 weeks (364 days) of 7-row calendar layout ending on today's date
  const weeks = useMemo(() => {
    const totalDays = 52 * 7;
    const cellMap = new Map<string, number>();
    for (const c of cells) {
      cellMap.set(c.date, c.count);
    }

    const today = new Date();
    const result: { date: string; count: number; month: number }[][] = [];

    // Construct 52 weeks of 7 days
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - totalDays + 1);

    let currentWeek: { date: string; count: number; month: number }[] = [];
    for (let d = 0; d < totalDays; d++) {
      const cur = new Date(startDate);
      cur.setDate(startDate.getDate() + d);
      const iso = cur.toISOString().slice(0, 10);
      const count = cellMap.get(iso) ?? 0;
      currentWeek.push({ date: iso, count, month: cur.getMonth() });

      if (currentWeek.length === 7) {
        result.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length > 0) {
      result.push(currentWeek);
    }
    return result;
  }, [cells]);

  return (
    <div className={cn('space-y-3 select-none', className)}>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3.5px] min-w-[700px]">
          {weeks.map((week, wIdx) => (
            <div key={wIdx} className="flex flex-col gap-[3.5px]">
              {week.map((cell) => {
                const level = intensity(cell.count, max);
                return (
                  <div
                    key={cell.date}
                    title={`${cell.date}: ${cell.count > 0 ? cell.count.toLocaleString() + ' tokens' : 'No activity'}`}
                    className={cn(
                      'size-[11px] rounded-[2.5px] transition-all hover:scale-125 cursor-pointer',
                      LEVELS[level],
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* 12-Month labels row along the bottom */}
        <div className="flex justify-between pt-2.5 px-1 text-[11px] text-muted-foreground/60 min-w-[700px]">
          {MONTH_NAMES.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>

      {legend && (
        <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
          <span>Less</span>
          <div className="flex gap-[3px]">
            {LEVELS.map((cls, i) => (
              <div key={i} className={cn('size-[10px] rounded-[2px]', cls)} />
            ))}
          </div>
          <span>More</span>
        </div>
      )}
    </div>
  );
}
