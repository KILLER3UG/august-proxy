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

import { Children, useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn, fmtElapsed } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';

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
  // The collapsed group is the state a screen reader navigates, so the trigger
  // has to resolve to a region that exists in BOTH states — the pairing
  // DisclosureRow owns. Measured in the running app this row advertised
  // `aria-expanded` with nothing behind it. The region wrapper is always
  // mounted (empty while closed); the rows still mount lazily.
  const uid = useId();
  const triggerId = `${uid}-group-trigger`;
  const regionId = `${uid}-group-region`;
  const elapsed =
    typeof elapsedMs === 'number' && elapsedMs >= 1000 ? fmtElapsed(elapsedMs) : null;
  const rows = Children.toArray(children);

  return (
    <div
      className="ledger row-enter"
      data-slot="activity-group"
      data-group-key={groupKey}
      data-open={expanded}
    >
      <Button
        variant="bare"
        type="button"
        className="ledger-head"
        onClick={() => onToggle(!expanded)}
        id={triggerId}
        aria-expanded={expanded}
        aria-controls={regionId}
        data-testid="activity-group-head"
      >
        <span className={cn('ledger-pulse', !running && 'ledger-pulse--idle')} aria-hidden />
        <strong data-testid="activity-group-summary">{summary}</strong>
        {failed && (
          <span className="ledger-failed" data-testid="activity-group-failed">
            <AlertCircle className="size-3" aria-hidden />
            failed
          </span>
        )}
        <span className="ledger-meta">
          {elapsed ? <span data-testid="activity-group-elapsed">{elapsed}</span> : null}
        </span>
        <SignalIcon name="chev" className="chev" />
      </Button>

      <div id={regionId} role="region" aria-labelledby={triggerId}>
        {expanded && rows.length > 0 ? (
          <div className="ledger-body" data-testid="activity-group-body">
            {rows.map((row, i) => (
              <div key={i} className="ledger-row-wrap">
                {row}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
