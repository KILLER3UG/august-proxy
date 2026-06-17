/* ── RightDrawerTasksSection ─ Workbench todo list ───────────────── */

import { Check, ArrowRight, Circle, CheckSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkbenchTodo } from '@/types/workbench';

export function RightDrawerTasksSection({ todos }: { todos: WorkbenchTodo[] }) {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress');

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-muted-foreground">
          {active ? 'Current step' : total > 0 ? 'All steps' : 'No todos'}
        </div>
        <div className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{done}/{total}</div>
      </div>

      {todos.length === 0 && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          No Workbench todos for this session.
        </div>
      )}

      {active && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-blue-400 font-semibold">
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
              todo.status === 'completed' && 'border-emerald-500/15 bg-emerald-500/5',
              todo.status === 'in_progress' && 'border-blue-500/25 bg-blue-500/5',
              todo.status === 'pending' && 'border-border/60 bg-card/40'
            )}
          >
            <span className="pt-0.5 shrink-0">
              {todo.status === 'completed' ? (
                <Check className="size-3 text-emerald-500" />
              ) : todo.status === 'in_progress' ? (
                <ArrowRight className="size-3 text-blue-500" />
              ) : (
                <Circle className="size-3 text-muted-foreground/45" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground/55 tabular-nums">
                  A{index + 1}
                </span>
                {index === activeIndex && (
                  <CheckSquare className="size-3 text-blue-500" />
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
