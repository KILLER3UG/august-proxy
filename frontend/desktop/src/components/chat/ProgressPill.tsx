/* ── ProgressPill ─ expandable todo pill for the chat surface ────────── */
/* Renders the workbench todo list as a compact pill (e.g. "Todos 3/10")   */
/* next to the running turn. Clicking the pill expands it inline to show   */
/* the full list using the ZCode reference style:                          */
/*   - Each row prefixed with a step code (A1, A2, A3...) and a status     */
/*     glyph (→ active / ○ pending / ✓ done)                              */
/*   - Long item text wraps inside the row (no truncation)                */
/*   - "N waiting…" / "Hide N waiting" toggle for the overflow tail        */
/*                                                                            */
/* This mirrors the small "Changes +27 -0" pill in the right rail: a         */
/* compact counter chip that the user clicks to expand. */

import { useState } from 'react';
import { CheckSquare, Square, ArrowRight, Circle, Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkbenchTodo } from '@/types/workbench';

const PILL_VISIBLE_LIMIT = 5;

export interface ProgressPillProps {
  todos: WorkbenchTodo[];
  className?: string;
}

export function ProgressPill({ todos, className }: ProgressPillProps) {
  const [open, setOpen] = useState(true);

  if (!todos || todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const active = todos.find(t => t.status === 'in_progress');
  const allDone = done === total;

  return (
    <div
      className={cn(
        'mx-auto max-w-3xl rounded-lg border border-border bg-card/60 overflow-hidden',
        className
      )}
      data-slot="progress-pill"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left',
          'hover:bg-white/[0.03] transition-colors'
        )}
        aria-expanded={open}
      >
        <span className="text-muted-foreground/70 shrink-0">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[10.5px] uppercase tracking-widest text-muted-foreground/80 font-semibold shrink-0">
          Todos
        </span>
        <span className="font-mono tabular-nums text-[10.5px] text-muted-foreground/70 shrink-0">
          {done}/{total}
        </span>
        {allDone ? (
          <CheckSquare size={12} className="text-emerald-500 shrink-0" />
        ) : active ? (
          <Loader2 size={12} className="text-blue-500 animate-spin shrink-0" />
        ) : (
          <Square size={12} className="text-muted-foreground/45 shrink-0" />
        )}
        <span className="ml-auto text-[11px] text-muted-foreground/80 truncate min-w-0">
          {allDone
            ? 'All steps complete'
            : active?.content
              ? truncate(active.content, 80)
              : `${total - done} step${total - done === 1 ? '' : 's'} pending`}
        </span>
      </button>

      {open && <ProgressList todos={todos} />}
    </div>
  );
}

function ProgressList({ todos }: { todos: WorkbenchTodo[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const visible = expanded ? todos : todos.slice(0, PILL_VISIBLE_LIMIT);
  const overflow = total - visible.length;
  const activeIdx = todos.findIndex(t => t.status === 'in_progress');

  return (
    <div className="px-3 pb-3 pt-1 border-t border-white/[0.05]">
      <div className="space-y-0.5">
        {visible.map((t) => {
          const absoluteIndex = todos.indexOf(t);
          const code = `A${absoluteIndex + 1}`;
          const isActive = absoluteIndex === activeIdx;
          return (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-1.5 text-[12px] leading-snug py-0.5',
                isActive ? 'text-foreground' : 'text-muted-foreground/80'
              )}
              data-status={t.status}
            >
              <span
                aria-hidden
                className={cn(
                  'shrink-0 inline-flex justify-center w-3.5 pt-px tabular-nums font-bold',
                  t.status === 'in_progress' && 'text-blue-500',
                  t.status === 'completed' && 'text-emerald-500',
                  t.status === 'pending' && 'text-muted-foreground/45'
                )}
              >
                {t.status === 'completed' ? (
                  <Check size={11} strokeWidth={3} />
                ) : t.status === 'in_progress' ? (
                  <ArrowRight size={11} strokeWidth={3} />
                ) : (
                  <Circle size={9} strokeWidth={2} />
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 wrap-anywhere',
                  t.status === 'completed' && 'line-through text-muted-foreground/55'
                )}
              >
                <span className="font-mono text-muted-foreground/55 mr-1.5">{code}:</span>
                {t.content || `Step ${absoluteIndex + 1}`}
              </span>
            </div>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(o => !o)}
            className="text-[10.5px] text-muted-foreground/60 italic hover:text-foreground/80 pl-5 pt-0.5 transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? `Hide ${overflow} waiting…` : `${overflow} waiting…`}
          </button>
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}
