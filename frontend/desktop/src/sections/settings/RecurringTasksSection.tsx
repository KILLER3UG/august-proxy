/* ── RecurringTasksSection — the recurring-task daemon manager (B7) ──── */
/* Reminders like "every 2 hours, remind me to stand up" or "when I open
 * the repo, remind me to run migrations". Fired at turn start → bell. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageLoader } from '@/components/PageLoader';
import { api } from '@/api/client';

interface RecurringTask {
  id: number;
  trigger: string;
  message: string;
  active: number;
  created_at?: string;
  last_fired_at?: string | null;
}

export function RecurringTasksSection() {
  const qc = useQueryClient();
  const [trigger, setTrigger] = useState('');
  const [message, setMessage] = useState('');

  const { data, error, isFetching } = useQuery<{ tasks: RecurringTask[] }>({
    queryKey: ['recurring-tasks'],
    queryFn: async () => api.get<{ tasks: RecurringTask[] }>('/api/tasks/recurring'),
    staleTime: 10_000,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['recurring-tasks'] });

  const addTask = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/api/tasks/recurring', { trigger, message }),
    onSuccess: () => {
      toast.success('Reminder added');
      setTrigger('');
      setMessage('');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Could not add reminder'),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => api.delete(`/api/tasks/recurring/${id}`),
    onSuccess: () => {
      toast.success('Reminder removed');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Could not remove reminder'),
  });

  const tasks = data?.tasks ?? [];

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Bell className="size-4 text-primary" />
        <div>
          <h2 className="text-sm font-semibold">Reminders</h2>
          <p className="text-xs text-muted-foreground">
            Fired when a chat turn starts — surfaced in the notification bell.
          </p>
        </div>
      </div>

      <Card className="p-4 space-y-2">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Trigger grammar:</span>{' '}
          <code className="font-mono">every 2 hours</code> ·{' '}
          <code className="font-mono">every 30 minutes</code> ·{' '}
          <code className="font-mono">every 1 day</code> — interval-based; or{' '}
          <code className="font-mono">when I open the repo</code> — once per day, workspace-matched.
        </p>
        <input
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
          placeholder='Trigger — e.g. "every 2 hours" or "when I open august-proxy"'
          aria-label="Reminder trigger"
          data-testid="reminder-trigger"
        />
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
          placeholder="What to remind you about"
          aria-label="Reminder message"
          data-testid="reminder-message"
        />
        <button
          type="button"
          disabled={addTask.isPending || !trigger.trim() || !message.trim()}
          onClick={() => addTask.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
          data-testid="reminder-add"
        >
          <Plus className="size-3" />
          Add reminder
        </button>
      </Card>

      {error ? (
        <p className="text-xs text-danger">Error loading reminders: {error.message}</p>
      ) : isFetching && tasks.length === 0 ? (
        <PageLoader label="Loading reminders…" variant="card" className="py-4" />
      ) : tasks.length === 0 ? (
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">
            No reminders yet — add one above, or tell August{" "}
            <code className="font-mono">"remind me every hour to check the build"</code> and it
            will suggest saving it.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="rounded-lg border border-border p-3 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {t.trigger}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  {t.last_fired_at ? (
                    <span className="text-[10px] text-muted-foreground">
                      last fired {new Date(t.last_fired_at).toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">never fired</span>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteTask.mutate(t.id)}
                    className="p-1 rounded text-muted-foreground hover:text-danger"
                    title="Remove reminder"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              </div>
              <p className="text-muted-foreground">{t.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
