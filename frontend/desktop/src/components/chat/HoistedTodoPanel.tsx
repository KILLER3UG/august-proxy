import { Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/**
 * HoistedTodoPanel — task list hoisted above message content
 *
 * Renders a todo/task list that appears at the top of an assistant message
 * (hoisted above the text content), showing the current task with checkboxes.
 */
export function HoistedTodoPanel({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;

  const label =
    todos.find(t => t.status === 'in_progress')?.content ??
    todos.find(t => t.status === 'pending')?.content ??
    todos[todos.length - 1]?.content ??
    'Tasks';

  return (
    <section
      className="mt-1 mb-3 inline-block w-fit max-w-full overflow-hidden rounded-2xl border border-border/70 bg-card align-top shadow-sm"
      data-slot="todo-hoisted"
    >
      <header className="px-3 pt-3 pb-2">
        <span className="block max-w-full truncate text-sm font-semibold leading-tight tracking-tight text-foreground" title={label}>
          {label}
        </span>
      </header>
      <ul className="grid min-w-0 gap-0.5 px-3 pb-3">
        {todos.map(todo => (
          <li
            className={cn(
              'flex min-w-0 items-center gap-3 py-1.5 transition-opacity',
              todo.status === 'in_progress' ? 'opacity-100' : 'opacity-45'
            )}
            key={todo.id}
          >
            <Checkmark status={todo.status} label={todo.content} />
            <span className="min-w-0 wrap-anywhere text-xs leading-[1.2rem] text-foreground">
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Checkmark({ status, label }: { status: TodoItem['status']; label: string }) {
  if (status === 'in_progress') {
    return (
      <span
        aria-label={`In progress: ${label}`}
        className="grid size-4 shrink-0 place-items-center rounded-full border border-ring/65 bg-primary/15"
      >
        <Loader2 className="size-3 animate-spin text-primary" />
      </span>
    );
  }

  const checked = status === 'completed';

  return (
    <span
      aria-label={label}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
        checked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border/80',
        status === 'cancelled' && 'border-muted-foreground/40'
      )}
    >
      {checked && <Check className="size-3" />}
    </span>
  );
}
