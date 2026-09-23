/* ── RightDrawerJobsSection ─ live background job tray ─────────────────── */
/* Renders the BackgroundTaskRegistry store, which long-running frontend jobs */
/* (sandbox preparation, queue overflow) already write to but nothing showed. */

import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  Circle,
  CircleAlert,
  ListX,
  Loader2,
  SquareTerminal,
} from 'lucide-react';
import { cn, fmtElapsed } from '@/lib/utils';
import {
  useBackgroundTasksStore,
  type BackgroundTask,
} from '@/store/background-tasks';

const STATUS_GLYPH = {
  queued: Circle,
  running: Loader2,
  done: Check,
  error: CircleAlert,
  cancelled: Ban,
} as const;

const ACTIVE = new Set(['queued', 'running']);

/** Advances once a second only while something is actually running. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}

function JobRow({ task, onDismiss }: { task: BackgroundTask; onDismiss?: () => void }) {
  const Glyph = STATUS_GLYPH[task.status] ?? Circle;
  const running = task.status === 'running';
  const settled = !ACTIVE.has(task.status);
  const spanMs = (running ? Date.now() : task.updatedAt) - task.createdAt;

  return (
    <li
      className="group relative flex items-start gap-2 rounded-lg border border-border/30 bg-card/30 px-2.5 py-2"
      data-testid="job-row"
      data-status={task.status}
    >
      <Glyph
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          running && 'animate-spin text-muted-foreground',
          task.status === 'done' && 'text-success',
          task.status === 'error' && 'text-danger',
          (task.status === 'queued' || task.status === 'cancelled') && 'text-muted-foreground/60',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground/90" title={task.label}>
          {task.label}
        </div>
        {task.detail ? (
          <div className="truncate font-mono text-[10.5px] text-muted-foreground/70" title={task.detail}>
            {task.detail}
          </div>
        ) : null}
        {typeof task.progress === 'number' ? (
          <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted/40">
            <div
              className="h-full rounded-full bg-primary/50"
              style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
            />
          </div>
        ) : null}
      </div>
      {spanMs > 0 ? (
        <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {fmtElapsed(spanMs)}
        </span>
      ) : null}
      {settled && onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${task.label}`}
          className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Ban className="size-3" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

export function RightDrawerJobsSection({ sessionId }: { sessionId: string | null }) {
  const tasks = useBackgroundTasksStore((s) => s.tasks);
  const clearFinished = useBackgroundTasksStore((s) => s.clearFinished);
  const remove = useBackgroundTasksStore((s) => s.remove);

  // Scoped to the session when one is set; jobs with no session stay visible
  // so a finished sandbox prep doesn't silently vanish between chats.
  const visible = sessionId
    ? tasks.filter((t) => !t.sessionId || t.sessionId === sessionId)
    : tasks;
  const activeCount = visible.filter((t) => ACTIVE.has(t.status)).length;
  const finishedCount = visible.length - activeCount;
  useTicker(activeCount > 0);

  if (visible.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <SquareTerminal className="size-5 text-muted-foreground/40" aria-hidden />
        <p className="text-xs text-muted-foreground/70">
          No background jobs. Long-running work started from Settings or an
          overflowing queue appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          {activeCount > 0 ? `${activeCount} running` : 'Idle'}
        </span>
        {finishedCount > 0 ? (
          <button
            type="button"
            onClick={clearFinished}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
            data-testid="jobs-clear-finished"
          >
            <ListX className="size-3" aria-hidden />
            Clear finished
          </button>
        ) : null}
      </div>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {visible.map((task) => (
          <JobRow
            key={task.id}
            task={task}
            onDismiss={ACTIVE.has(task.status) ? undefined : () => remove(task.id)}
          />
        ))}
      </ul>
    </div>
  );
}
