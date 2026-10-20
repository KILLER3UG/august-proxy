/* ── ActivityGroup — one line for a run of tool calls ────────────────── */
/* The reference transcript collapses a run of tool calls into a single
 * activity line — a warm dot, one phrase, the elapsed time, a chevron — and
 * reveals the individual calls in a bordered card when it is opened.
 *
 * Every kind of tool work joins the line: reads, commands, edits, memory
 * writes, plain tool calls. A mixed run (a read, a command, a read) is one
 * thing that happened, and the phrase names each kind.
 *
 * A run that FAILED is grouped too, and the line is marked and OPENS: a
 * failure behind a collapsed line is one nobody sees.
 *
 * The grouping is a RENDER-TIME arrangement, not a new persisted block kind:
 * the transcript still stores one block per tool call, so a reload produces
 * the same grouping and nothing in the backend has to know about it.
 *
 * The card's first row IS the summary line. The children sit under it,
 * separated by hairlines, so a run reads as one thing with a list inside it
 * rather than as a stack of separate rows that happen to be adjacent. */

import { Children, type ReactNode } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { cn, fmtElapsed } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function ActivityGroup({
  summary,
  elapsedMs,
  running,
  failed,
  expanded,
  onToggle,
  groupKey,
  children,
}: {
  /** The phrase for the whole run — "Ran 4 commands, read a file". */
  summary: string;
  /** Total time for the run, in ms. Hidden under a second: a sub-second
   *  duration reads as noise, and the reference shows whole seconds. */
  elapsedMs?: number;
  running: boolean;
  /** The run contains a failure. The line is MARKED, and the group opens
   *  on it: a failure behind a collapsed line is one nobody sees. */
  failed?: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  /** Stable key for the manual expand override. */
  groupKey: string;
  children: ReactNode;
}) {
  const elapsed =
    typeof elapsedMs === 'number' && elapsedMs >= 1000 ? fmtElapsed(elapsedMs) : null;
  const rows = Children.toArray(children);

  return (
    <div className="row-enter my-0.5" data-slot="activity-group" data-group-key={groupKey}>
      <div className="overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.02]">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full shrink justify-start gap-2 whitespace-normal rounded-none px-2.5 py-1.5 text-left text-[0.8125rem] font-medium text-foreground/85 hover:bg-white/[0.03] hover:text-foreground"
          onClick={() => onToggle(!expanded)}
          aria-expanded={expanded}
          data-testid="activity-group-head"
        >
          {running ? (
            <span className="activity-dots shrink-0" aria-hidden>
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
          ) : (
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
          )}
          {/* NOT `flex-1`. The reference puts the duration and the chevron
              IMMEDIATELY after the title -- "Comparing two lesser-known
              language models  9s >" -- and the rest of the row is empty. A
              growing summary span pushed the chevron to the far right of the
              content column instead, which is a different row. It still
              shrinks (`min-w-0` + `truncate`), it just no longer GROWS. */}
          <span
            className="min-w-0 truncate text-[0.8125rem] font-medium text-foreground/85"
            data-testid="activity-group-summary"
          >
            {summary}
          </span>
          {failed && (
            <span
              className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-danger-fg"
              data-testid="activity-group-failed"
            >
              <AlertCircle className="size-3 text-danger" aria-hidden />
              failed
            </span>
          )}
          {elapsed ? (
            <span
              className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/60"
              data-testid="activity-group-elapsed"
            >
              {elapsed}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground/60 transition-transform',
              !expanded && '-rotate-90',
            )}
            aria-hidden
          />
        </Button>

        {expanded && rows.length > 0 ? (
          <div className="border-t border-white/[0.06] px-2 py-1" data-testid="activity-group-body">
            {rows.map((row, i) => (
              <div key={i} className={cn(i > 0 && 'border-t border-white/[0.05]')}>
                {row}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
