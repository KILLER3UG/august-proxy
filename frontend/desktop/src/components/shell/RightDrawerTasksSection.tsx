/* ── RightDrawerTasksSection ─ Workbench todo list ───────────────── */
/*                                                                          */
/* Color branding matches the dropdown / banner family:                      */
/*   - active:   primary accent (indigo)                                    */
/*   - completed: emerald                                                     */
/*   - pending:  muted neutral                                               */
/* Also: rounded-xl / border / bg-card / shadow-2xl on the header strip.    */

import { Check, ArrowRight, Circle, CheckSquare, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkbenchTodo } from '@/types/workbench';

export function RightDrawerTasksSection({ todos }: { todos: WorkbenchTodo[] }) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress');

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

      <div className="space-y-1">
        {todos.map((todo, index) => (
          <div
            key={todo.id}
            className={cn(
              'flex items-start gap-2 rounded-lg border px-2.5 py-2',
              todo.status === 'completed' && 'border-success/15 bg-success/5',
              todo.status === 'in_progress' && 'border-primary/25 bg-primary/5',
              todo.status === 'pending' && 'border-border/60 bg-card/40'
            )}
          >
            <span className="pt-0.5 shrink-0">
              {todo.status === 'completed' ? (
                <Check className="size-3 text-success" />
              ) : todo.status === 'in_progress' ? (
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
                todo.status === 'completed' && 'text-muted-foreground line-through',
                todo.status === 'in_progress' && 'text-foreground',
                todo.status === 'pending' && 'text-muted-foreground/75'
              )}>
                {todo.content}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
