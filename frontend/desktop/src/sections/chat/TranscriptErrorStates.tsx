/* ── Transcript failure states ───────────────────────────────────────────
 *
 * Two places in the transcript can fail in front of the user, and both used
 * to render nothing at all — a failed history load was a silently blank pane,
 * and a failed sub-agent roster left stale rows with no explanation. They live
 * here, apart from `ChatThread`, for two reasons: they are the only two
 * branches of that component whose entire content is a function of "something
 * went wrong", and a 1,700-line transcript has no business owning markup that
 * can be read (and regression-tested) on its own. */

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** History could not be restored for this session. Named and explained,
 *  because a blank transcript is indistinguishable, to the user, from a chat
 *  that was deleted. */
export function HistoryLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-[var(--shell-inset-x)] py-16 text-center">
      <AlertCircle className="size-6 text-danger" aria-hidden />
      <p className="text-sm font-medium text-foreground">Couldn't load this conversation</p>
      <p className="text-2xs text-muted-foreground">{error}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The sub-agent roster poller failed while sub-agent rows are on screen.
 *  Quiet by design — `role="status"`, not `alert`, because the transcript
 *  below it is still real — but it says WHY it is incomplete and offers the
 *  retry the 10s poll would otherwise make the user wait out. */
export function RosterError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="mx-auto w-full max-w-3xl px-[var(--shell-inset-x)] pt-3"
      role="status"
      data-testid="roster-error"
    >
      <div className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-1.5 text-2xs text-muted-foreground">
        <AlertCircle className="size-3 shrink-0 text-warning" aria-hidden />
        <span>Sub-agent status is temporarily unavailable — retrying.</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="ml-auto text-2xs"
        >
          Retry
        </Button>
      </div>
    </div>
  );
}