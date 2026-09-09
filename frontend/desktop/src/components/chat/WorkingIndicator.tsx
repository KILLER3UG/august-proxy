/* ── WorkingIndicator ─────────────────────────────────────────────────── */
/* Shown above the composer while a turn streams. Two parts:              */
/*   • the AUG wordmark (kept for identity),                              */
/*   • a progressive sentence stack pulled from the session's live        */
/*     activity store — every finished step ("Read x", "Ran tests",       */
/*     "Edited y") renders as its own line, newest at the bottom,         */
/*     older lines dimming away Claude-style. While the model is          */
/*     between steps the last line carries animated ellipsis dots.        */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronDown, Circle, Loader2, Minus } from 'lucide-react';
import { useLiveActivityStore } from '@/store/liveActivity';
import { resolveUiSessionId } from '@/sections/chat/stream/session-id-map';
import { cn } from '@/lib/utils';

interface WorkingIndicatorProps {
  className?: string;
  /** Live session key — subscribes to that session's activity feed. */
  sessionId?: string | null;
}

/** Sentences visible at once (oldest fade out above). */
const MAX_LINES = 3;

function trimLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 96 ? `${t.slice(0, 94)}…` : t;
}

function AugWordmark() {
  const LETTERS = ['A', 'U', 'G', 'U', 'S', 'T'];
  return (
    <span className="flex items-center justify-center gap-[3px]">
      {LETTERS.map((letter, i) => (
        <span
          key={i}
          className="aug-letter text-[11px] font-semibold tracking-[0.18em] text-muted-foreground/80"
          style={{ animationDelay: `${i * 0.12}s` }}
        >
          {letter}
        </span>
      ))}
      <span className="aug-caret ml-0.5 text-[11px] font-semibold text-primary/70">|</span>
    </span>
  );
}

function Dots({ tone = 'text-muted-foreground/70' }: { tone?: string }) {
  return (
    <span className={`ml-0.5 inline-flex items-baseline ${tone}`} data-testid="typing-dots">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="text-[12px] leading-none"
          animate={{ opacity: [0.15, 0.9, 0.15] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.22, ease: 'easeInOut' }}
        >
          .
        </motion.span>
      ))}
    </span>
  );
}

function cleanThinkingText(s: string): string {
  let cleaned = s.replace(/^Thinking(?:\.{1,3}|:|\s*·|\s+)/i, '').trim();
  cleaned = cleaned.replace(/^\.+|\.+$/g, '').trim();
  return cleaned;
}

export function WorkingIndicator({ className, sessionId }: WorkingIndicatorProps) {
  // The activity store is keyed by UI session id; the pane may hand us a
  // wb_* route id, so normalize before subscribing.
  const uiKey = sessionId ? resolveUiSessionId(sessionId) : null;
  // Raw slice subscription (stable reference) — deriving in a zustand
  // selector would allocate a fresh object per tick and loop re-renders.
  const entry = useLiveActivityStore((s) => (uiKey ? s.bySession[uiKey] : undefined));

  // Newest-last sentence list: one line per activity item, consecutive and
  // earlier duplicates collapse (a retried tool replaces its old line).
  const lines = useMemo(() => {
    const items = entry?.items ?? [];
    const out: string[] = [];
    for (const item of items) {
      let line = '';
      if (item.kind === 'thinking') {
        const rawDetail = (item.detail || '').split('\n')[0];
        const cleaned = cleanThinkingText(rawDetail || item.label);
        line = trimLine(cleaned);
      } else {
        const base = item.status === 'error' ? `${item.label} — failed` : item.label;
        const detail = (item.detail || '').split('\n')[0];
        line = trimLine(detail && detail !== item.label ? `${base} · ${detail}` : base);
      }
      if (!line) continue;
      const dupIdx = out.lastIndexOf(line);
      if (dupIdx >= 0) out.splice(dupIdx, 1);
      out.push(line);
    }
    return out.slice(-MAX_LINES);
  }, [entry]);

  const idle = lines.length === 0;
  const execution = entry?.execution;
  const todos = entry?.todos;
  const todoList = todos?.items ?? [];
  const todosDone = todoList.filter((t) => t.status === 'completed').length;
  const todoCurrent =
    todoList.find((t) => t.status === 'in_progress') ??
    todoList.find((t) => t.status === 'pending');
  const [todosOpen, setTodosOpen] = useState(false);

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
      data-aug-indicator
    >
      <div className="flex flex-col items-center gap-0.5 py-0.5">
        <AugWordmark />
        {todoList.length > 0 ? (
          /* Live todo checklist (submit_todos / update_todos) — the header
             pill answers "how many steps and where are we"; expanding it
             shows every row with its status. Falls back to the bare
             phase pill when the model never submitted todos. */
          <div className="flex flex-col items-center gap-1" data-testid="working-todos">
            <button
              type="button"
              onClick={() => setTodosOpen((v) => !v)}
              aria-expanded={todosOpen}
              className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-px text-[10px] font-medium tracking-wide text-primary transition-colors hover:bg-primary/15"
              data-testid="working-todos-toggle"
            >
              <span className="max-w-[240px] truncate">{todos?.title || 'Plan'}</span>
              <span className="tabular-nums opacity-80">
                {todosDone}/{todoList.length}
              </span>
              <ChevronDown
                className={cn('size-3 transition-transform', todosOpen && 'rotate-180')}
                aria-hidden
              />
            </button>
            {todosOpen ? (
              <div className="w-full max-w-md rounded-lg border border-border/50 bg-card/80 px-3 py-1.5 text-left">
                {todoList.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start gap-2 py-0.5 text-[11px] leading-4"
                    data-testid="working-todo-row"
                    data-status={t.status}
                  >
                    <span className="mt-px shrink-0" aria-hidden>
                      {t.status === 'completed' ? (
                        <Check className="size-3 text-emerald-400" />
                      ) : t.status === 'in_progress' ? (
                        <Loader2 className="size-3 animate-spin text-primary" />
                      ) : t.status === 'cancelled' ? (
                        <Minus className="size-3 text-muted-foreground/50" />
                      ) : (
                        <Circle className="size-3 text-muted-foreground/50" />
                      )}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        t.status === 'completed' && 'text-muted-foreground/60 line-through',
                        t.status === 'cancelled' && 'text-muted-foreground/50 line-through',
                        t.status === 'in_progress' && 'text-foreground/90',
                        t.status === 'pending' && 'text-muted-foreground',
                      )}
                      title={t.content}
                    >
                      {t.content}
                    </span>
                  </div>
                ))}
              </div>
            ) : todoCurrent ? (
              <div
                className="max-w-md truncate text-center text-[11px] text-muted-foreground"
                data-testid="working-todo-current"
                title={todoCurrent.content}
              >
                {todoCurrent.content}
              </div>
            ) : null}
          </div>
        ) : execution ? (
          <div
            className="rounded-full border border-primary/25 bg-primary/10 px-2 py-px text-[10px] font-medium uppercase tracking-wide text-primary"
            data-testid="working-phase"
          >
            {execution.phase}
            {execution.step > 0 ? ` · step ${execution.step}` : ''}
          </div>
        ) : null}
        <div className="w-full max-w-xl" data-testid="working-lines">
          {idle ? (
            <div
              key="idle-line"
              className="flex items-baseline justify-center gap-1 text-[11.5px] italic leading-4 text-muted-foreground/70"
            >
              <span>Thinking</span>
              <Dots />
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {lines.map((line, i) => {
                const isLast = i === lines.length - 1;
                const opacityClass = isLast
                  ? 'opacity-95 text-foreground/90 font-normal'
                  : i === lines.length - 2
                    ? 'opacity-60 text-muted-foreground'
                    : 'opacity-35 text-muted-foreground';
                return (
                  <div
                    key={`slot-${i}`}
                    className={`truncate text-center text-[11.5px] leading-4 transition-opacity duration-150 ${opacityClass}`}
                  >
                    <span>{line}</span>
                    {isLast && <Dots tone="text-primary/60" />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
