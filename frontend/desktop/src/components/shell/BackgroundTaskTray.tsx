/* ── Background task tray ─────────────────────────────────────────────── */
/* Compact tray in the chrome for queue / sandbox / long jobs.            */

import { useEffect } from 'react';
import { ListTodo, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBackgroundTasksStore } from '@/store/background-tasks';
import { OsNotifyService } from '@/lib/os-notify';

export function BackgroundTaskTrayButton() {
  const tasks = useBackgroundTasksStore((s) => s.tasks);
  const trayOpen = useBackgroundTasksStore((s) => s.trayOpen);
  const setTrayOpen = useBackgroundTasksStore((s) => s.setTrayOpen);
  const active = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;

  return (
    <button
      type="button"
      onClick={() => setTrayOpen(!trayOpen)}
      className={cn(
        'relative inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition',
        active > 0
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border/60 text-muted-foreground hover:bg-muted/40',
      )}
      title="Background tasks"
      data-testid="background-task-tray-btn"
    >
      <ListTodo className="size-3" />
      Tasks
      {active > 0 && (
        <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums">
          {active}
        </span>
      )}
    </button>
  );
}

export function BackgroundTaskTrayPanel() {
  const tasks = useBackgroundTasksStore((s) => s.tasks);
  const trayOpen = useBackgroundTasksStore((s) => s.trayOpen);
  const setTrayOpen = useBackgroundTasksStore((s) => s.setTrayOpen);
  const clearFinished = useBackgroundTasksStore((s) => s.clearFinished);
  const remove = useBackgroundTasksStore((s) => s.remove);

  // OS notify when a task transitions to done (opt-in)
  useEffect(() => {
    if (!OsNotifyService.isEnabled()) return;
    const last = tasks[0];
    if (last?.status === 'done' && Date.now() - last.updatedAt < 2000) {
      void OsNotifyService.notifyJobComplete(last.label, last.detail);
    }
  }, [tasks]);

  if (!trayOpen) return null;

  return (
    <div
      className="absolute bottom-8 right-3 z-50 w-80 rounded-xl border border-border bg-popover shadow-2xl"
      data-testid="background-task-tray"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-xs font-semibold">Background tasks</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={clearFinished}
          >
            Clear finished
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            onClick={() => setTrayOpen(false)}
            aria-label="Close tray"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <ul className="max-h-64 overflow-auto p-2 space-y-1.5">
        {tasks.length === 0 && (
          <li className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            No background jobs yet. Long runs and sandbox cells appear here.
          </li>
        )}
        {tasks.map((t) => (
          <li
            key={t.id}
            className="flex items-start gap-2 rounded-lg border border-border/50 bg-card/40 px-2 py-1.5 text-[11px]"
          >
            <StatusIcon status={t.status} />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{t.label}</div>
              {t.detail && (
                <div className="text-muted-foreground truncate">{t.detail}</div>
              )}
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === 'done') {
    return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />;
  }
  return <AlertCircle className="size-3.5 shrink-0 text-destructive" />;
}
