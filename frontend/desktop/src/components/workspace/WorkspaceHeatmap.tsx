/* ── WorkspaceHeatmap — GitHub-style activity heatmap ────────────────── */
/* Pure CSS. 5-row layout so the calendar reads like a week column. */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  count: number;
}

export type ActivityMode = 'daily' | 'weekly' | 'cumulative';

interface Props {
  cells: HeatmapCell[];
  className?: string;
  /** Show the Less → More intensity legend. Defaults to true. */
  legend?: boolean;
  /** Aggregation of the 365-day grid. Defaults to 'daily' (raw per-day cells). */
  activityMode?: ActivityMode;
}

const LEVELS = [
  'bg-white/[0.035] border border-white/[0.02]',
  'bg-blue-900/60 border border-blue-800/40 text-blue-300',
  'bg-blue-700/80 border border-blue-600/50 text-blue-200',
  'bg-blue-600 border border-blue-500/60 text-white',
  'bg-blue-500 border border-blue-400/40 text-white shadow-sm shadow-blue-500/30',
];

function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function WorkspaceHeatmap({ cells, className, legend = true, activityMode = 'daily' }: Props) {
  // Generate 52 weeks (364 days) of 7-row calendar layout ending on today's
  // date, then aggregate per the mode. A cached date key per cell keeps the
  // aggregation from recomputing the grid.
  const { weeks, monthLabels } = useMemo(() => {
    const totalDays = 52 * 7;
    const cellMap = new Map<string, number>();
    for (const c of cells) {
      cellMap.set(c.date, c.count);
    }

    const today = new Date();
    const grid: { date: string; count: number; month: number }[][] = [];

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - totalDays + 1);

    let currentWeek: { date: string; count: number; month: number }[] = [];
    for (let d = 0; d < totalDays; d++) {
      const cur = new Date(startDate);
      cur.setDate(startDate.getDate() + d);
      // Local-time ISO key — matches the backend's `YYYY-MM-DD` day strings
      // (created_at is UTC but the card is read as local calendar days).
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
      currentWeek.push({ date: iso, count: cellMap.get(iso) ?? 0, month: cur.getMonth() });
      if (currentWeek.length === 7) {
        grid.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length > 0) {
      grid.push(currentWeek);
    }

    let weeks = grid;
    if (activityMode === 'weekly') {
      // Sum each calendar week (column) into a single cell.
      weeks = grid.map((week) => {
        const sum = week.reduce((acc, c) => acc + c.count, 0);
        return week.map((c, i) => ({ ...c, count: i === 0 ? sum : 0 }));
      });
    } else if (activityMode === 'cumulative') {
      // Running total: each day's cell shows tokens spent so far this year.
      let running = 0;
      weeks = grid.map((week) =>
        week.map((c) => {
          running += c.count;
          return { ...c, count: running };
        }),
      );
    }

    // Month labels derived from the grid, not hardcoded: one label per month
    // boundary, spaced by the weeks each month occupies so they track the
    // columns as the year rolls (a static list drifts wrong from next month).
    const labels: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;
    grid.forEach((week, wIdx) => {
      // Label a month at its FIRST full week in the grid, so the label sits
      // over the column where that month starts.
      const mid = week[3]?.month ?? week[0].month; // mid-week day decides the column's month
      if (mid !== lastMonth) {
        labels.push({ label: MONTH_LABELS[mid], weekIndex: wIdx });
        lastMonth = mid;
      }
    });

    return { weeks, monthLabels: labels };
  }, [cells, activityMode]);

  const max = useMemo(() => Math.max(0, ...weeks.flat().map((c) => c.count)), [weeks]);

  // Month labels render inside the same flex row as the weeks: each label is
  // absolutely positioned at its week column so it tracks the grid.
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

        {/* Month labels — derived from the grid, positioned under their first week */}
        <div className="relative pt-2.5 h-6 min-w-[700px]">
          {monthLabels.map(({ label, weekIndex }) => (
            <span
              key={`${label}-${weekIndex}`}
              className="absolute top-2.5 text-[11px] text-muted-foreground/60"
              style={{ left: `calc(${(weekIndex / weeks.length) * 100}% )` }}
            >
              {label}
            </span>
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
