/* ── RightDrawerTasksSection ─ Workbench todo list ───────────────── */
/*                                                                          */
/* Color branding matches the dropdown / banner family:                      */
/*   - active:   primary accent (indigo)                                    */
/*   - completed: emerald                                                     */
/*   - pending:  muted neutral                                               */
/* Also: rounded-xl / border / bg-card / shadow-2xl on the header strip.    */
/* U3: rows are interactive — clicking a todo's check toggles its status    */
/* through PATCH /api/workbench/todos (optimistic + invalidate).            */

import { useQueryClient } from '@tanstack/react-query';
import { Check, ArrowRight, Circle, CheckSquare, ListTodo, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { WorkbenchSession, WorkbenchTodo } from '@/types/workbench';

/** Toggle one todo's status server-side (U3). Returns the saved list. */
async function toggleTodoStatus(
  sessionId: string,
  todos: WorkbenchTodo[],
  id: string,
): Promise<WorkbenchTodo[]> {
  const next = todos.map((t) =>
    t.id === id
      ? {
          ...t,
          status:
            t.status === 'completed' ? 'pending' : ('completed' as WorkbenchTodo['status']),
        }
      : t,
  );
  const res = await fetch('/api/workbench/todos', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, todos: next }),
  });
  if (!res.ok) throw new Error(`toggle failed: ${res.status}`);
  const data = (await res.json()) as { todos?: WorkbenchTodo[] };
  return data.todos ?? next;
}

export function RightDrawerTasksSection({
  sessionId,
  todos,
}: {
  sessionId?: string | null;
  todos: WorkbenchTodo[];
}) {
  const qc = useQueryClient();
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress');

  /** Optimistically flip a todo, then reconcile with the server response. */
  const handleToggle = (todo: WorkbenchTodo) => {
    if (!sessionId || togglingId) return;
    setTogglingId(todo.id);
    // Optimistic write into whatever query cache holds this session.
    const queries = qc.getQueriesData<{ workbenchSession?: WorkbenchSession }>({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey.some((k) => typeof k === 'string' && k.includes('workbench')),
    });
    for (const [key, data] of queries) {
      if (!data?.workbenchSession?.todos) continue;
      qc.setQueryData(key, {
        ...data,
        workbenchSession: {
          ...data.workbenchSession,
          todos: data.workbenchSession.todos.map((t) =>
            t.id === todo.id
              ? {
                  ...t,
                  status:
                    t.status === 'completed'
                      ? 'pending'
                      : ('completed' as WorkbenchTodo['status']),
                }
              : t,
          ),
        },
      });
    }
    void toggleTodoStatus(sessionId, todos, todo.id)
      .then((saved) => {
        for (const [key, data] of queries) {
          if (!data?.workbenchSession?.todos) continue;
          qc.setQueryData(key, {
            ...data,
            workbenchSession: { ...data.workbenchSession, todos: saved },
          });
        }
      })
      .catch(() => {
        // Reconcile from server on failure (rolls the optimistic flip back).
        void qc.invalidateQueries({ queryKey: ['workbench'] });
      })
      .finally(() => setTogglingId(null));
  };

  return (
    <div className="h-full space-y-3 drawer-section-text">
      {/* Brand strip — same surface language as the PlanProposalBanner and
          the dropdown panels. Active = primary; no-todos = neutral. */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold',
          active
            ? 'border-primary/30 bg-primary/5 text-primary'
            : total > 0
              ? 'border-success/25 bg-success/5 text-success'
              : 'border-border bg-muted/30 text-muted-foreground'
        )}
      >
        <ListTodo className="size-3 shrink-0" />
        <span className="truncate">
          {active
            ? 'Current step'
            : total > 0
              ? 'All steps'
              : 'No todos'}
        </span>
        <span className="ml-auto font-mono text-xs tabular-nums opacity-80">
          {done}/{total}
        </span>
      </div>

      {todos.length === 0 && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          No Workbench todos for this session.
        </div>
      )}

      {active && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-primary font-semibold">
            <ArrowRight className="size-3" />
            In progress
          </div>
          <div className="text-foreground/90 leading-relaxed">{active.content}</div>
        </div>
      )}

      {(['in_progress', 'pending', 'completed'] as const).map((section) => {
        const items = todos.filter((todo) => todo.status === section);
        if (items.length === 0) return null;
        const labels = {
          in_progress: 'In progress',
          pending: 'Pending',
          completed: 'Completed',
        } as const;
        return (
          <div key={section} className="space-y-1">
            <div className="flex items-center gap-1.5 px-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
              <span className="size-1.5 rounded-full bg-current" />
              {labels[section]}
              <span className="ml-auto font-mono tabular-nums opacity-70">{items.length}</span>
            </div>
            {items.map((todo) => {
              const index = todos.indexOf(todo);
              const clickable = Boolean(sessionId) && togglingId !== todo.id;
              return (
                <div
                  key={todo.id}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                    section === 'completed' && 'border-success/15 bg-success/5',
                    section === 'in_progress' && 'border-primary/25 bg-primary/5',
                    section === 'pending' && 'border-border/60 bg-card/40',
                    clickable && 'cursor-pointer hover:border-primary/40'
                  )}
                  onClick={() => handleToggle(todo)}
                  role={sessionId ? 'checkbox' : undefined}
                  aria-checked={section === 'completed'}
                  tabIndex={sessionId ? 0 : undefined}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && sessionId) {
                      e.preventDefault();
                      handleToggle(todo);
                    }
                  }}
                  title={sessionId ? 'Click to toggle done' : undefined}
                >
                  <span className="pt-0.5 shrink-0">
                    {togglingId === todo.id ? (
                      <Loader2 className="size-3 animate-spin text-muted-foreground" />
                    ) : section === 'completed' ? (
                      <Check className="size-3 text-success" />
                    ) : section === 'in_progress' ? (
                      <ArrowRight className="size-3 text-primary" />
                    ) : (
                      <Circle className="size-3 text-muted-foreground/45" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground/55 tabular-nums">
                        A{index + 1}
                      </span>
                      {index === activeIndex && (
                        <CheckSquare className="size-3 text-primary" />
                      )}
                    </div>
                    <div className={cn(
                      'mt-0.5 leading-relaxed',
                      section === 'completed' && 'text-muted-foreground line-through',
                      section === 'in_progress' && 'text-foreground',
                      section === 'pending' && 'text-muted-foreground/75'
                    )}>
                      {todo.content}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
