/* ── BackgroundJobsButton — the global door to the background job tray ────
 *
 * The tray's list lived ONLY in a right-drawer section, and that is the wrong
 * home for it twice over:
 *
 *  1. The drawer is a CHAT surface — it is closed by default and it is
 *     scoped to the current chat — while the jobs it shows are APP-level (a
 *     sandbox prep, a kernel-venv build, both started from Settings). A job
 *     that finished while the user was in another chat had no door at all.
 *  2. The store was in-memory, so a reload emptied it: the drawer section was
 *     a list of nothing after a restart. The store now persists
 *     (`store/background-tasks.ts`), and this button is the surface that
 *     survives the reload.
 *
 * So this is not a RELOCATION of the drawer section — that stays where it is —
 * it is the global door the section never had.
 *
 * It stays QUIET, which is the reference's whole rule: with no jobs there is
 * no button at all, a running job is a spinner with a count, and a FINISHED
 * job is a muted dot rather than a badge, so the chrome only speaks when there
 * is something to say. The badge shape is the one the workbench launcher
 * already uses beside it.
 */

import { useEffect, useRef, useState } from 'react';
import { Activity, Loader2, ListX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBackgroundTasksStore } from '@/store/background-tasks';
import { JobRow } from './RightDrawerJobsSection';

const ACTIVE = new Set(['queued', 'running']);

export function BackgroundJobsButton() {
  const tasks = useBackgroundTasksStore((s) => s.tasks);
  const remove = useBackgroundTasksStore((s) => s.remove);
  const clearFinished = useBackgroundTasksStore((s) => s.clearFinished);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const running = tasks.filter((t) => ACTIVE.has(t.status)).length;
  const settled = tasks.length - running;

  // Outside click and Escape close the tray. The panel lives inside the
  // titlebar (not portalled), so the titlebar's own overflow cannot clip it
  // and no inline positioning is needed.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to say: no button at all. A permanent empty affordance is noise,
  // and the reference's rule is that the app only pushes what the user pulls.
  if (tasks.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        /* The shape is the workbench launcher's, which sits right beside it:
            44px, square, muted until hovered. The primitive's focus ring and
            the size scale come from the primitive. */
        className="relative size-11 rounded-none text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        title={
          running > 0
            ? `${running} background job${running === 1 ? '' : 's'} running`
            : `${settled} finished background job${settled === 1 ? '' : 's'}`
        }
        aria-label={
          running > 0
            ? `Background jobs: ${running} running`
            : `Background jobs: ${settled} finished`
        }
        aria-expanded={open}
        data-testid="background-jobs-button"
      >
        {running > 0 ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Activity className="size-3" />
        )}
        {running > 0 && (
          <span className="absolute right-1.5 top-1.5 min-w-3.5 rounded-full bg-warning px-1 text-2xs font-semibold leading-4 text-warning-foreground">
            {running > 9 ? '9+' : running}
          </span>
        )}
        {running === 0 && settled > 0 && (
          <span
            className="absolute bottom-2 right-2 size-1.5 rounded-full bg-muted-foreground"
            aria-hidden="true"
            data-testid="background-jobs-indicator"
          />
        )}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Background jobs"
          className="absolute right-0 top-full z-[70] mt-1 w-80 rounded-lg border border-border/50 bg-popover p-2 shadow-2xl"
          data-testid="background-jobs-panel"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
            <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">
              {running > 0 ? `${running} running` : 'Background jobs'}
            </span>
            {settled > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFinished}
                className="h-6 px-1.5 text-2xs font-normal text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
                data-testid="background-jobs-clear-finished"
              >
                <ListX className="size-3" aria-hidden />
                Clear finished
              </Button>
            )}
          </div>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {tasks.map((task) => (
              <JobRow
                key={task.id}
                task={task}
                onDismiss={ACTIVE.has(task.status) ? undefined : () => remove(task.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
