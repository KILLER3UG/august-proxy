/* ── TaskProgressPill ─────────────────────────────────────────────────── */
/* Floating interactive pill above the composer: "Step X/Y · N files changed" */
/* Inspired by the Qoder reference (media_1789722525840.png).                 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Circle, Loader2, Minus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useLiveActivityStore } from '@/store/liveActivity';
import { resolveUiSessionId } from '@/sections/chat/stream/session-id-map';
import { gitApi } from '@/api/git';
import { cn } from '@/lib/utils';
import { menuPanel } from '@/lib/motion';

interface TaskProgressPillProps {
  sessionId?: string | null;
  className?: string;
}

export function TaskProgressPill({ sessionId, className }: TaskProgressPillProps) {
  const uiKey = sessionId ? resolveUiSessionId(sessionId) : null;
  const entry = useLiveActivityStore((s) => (uiKey ? s.bySession[uiKey] : undefined));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const todos = entry?.todos;
  const todoList = todos?.items ?? [];
  const todosDone = todoList.filter((t) => t.status === 'completed').length;
  const totalTodos = todoList.length;

  // Poll git only while the turn can still change files. Terminal-ness is
  // read from the live-activity store events this component already receives
  // (`todosUpdated`, and the timeline's `clearLiveActivity` when the stream
  // ends), so the settle case is decided by that event instead of waiting
  // for a timer tick to discover an idle session: the render after the flip
  // hands `false` to React Query, which drops its single interval (it never
  // overlaps one) — and unmount tears the same interval down. Steps still
  // pending/in progress keep the unchanged 25s cadence.
  const stepActive = todoList.some(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  );
  const turnSettled = !entry || (todoList.length > 0 && !stepActive);

  const gitStatus = useQuery({
    queryKey: ['git', 'status', sessionId ?? null, null],
    queryFn: () => gitApi.status(sessionId ?? undefined, undefined),
    enabled: Boolean(sessionId),
    refetchInterval: turnSettled ? false : 25_000,
    staleTime: 8_000,
    retry: false,
  });

  const files = gitStatus.data?.files ?? [];
  const added = gitStatus.data?.added ?? 0;
  const removed = gitStatus.data?.removed ?? 0;

  // Close on click outside and escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
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

  // Only render when there are todos planned or files changed
  if (totalTodos === 0 && files.length === 0) return null;

  return (
    <div ref={rootRef} className={cn('relative inline-flex flex-col items-center', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="task-progress-pill-btn"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/85 backdrop-blur-sm px-3 py-1 text-xs font-medium text-foreground/80 shadow-xs transition-colors hover:bg-card hover:text-foreground cursor-pointer',
          open && 'border-primary/50 bg-card shadow-sm',
        )}
      >
        {totalTodos > 0 && (
          <span className="tabular-nums">
            Step {todosDone}/{totalTodos}
          </span>
        )}
        {totalTodos > 0 && files.length > 0 && (
          <span className="opacity-40" aria-hidden>
            ·
          </span>
        )}
        {files.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <span>
              {files.length} {files.length === 1 ? 'file' : 'files'} changed
            </span>
            {(added > 0 || removed > 0) && (
              <span className="font-mono text-[10.5px]">
                {added > 0 && <span className="text-emerald-500 font-semibold">+{added}</span>}
                {removed > 0 && (
                  <span className={cn('text-rose-500 font-semibold', added > 0 && 'ml-0.5')}>
                    -{removed}
                  </span>
                )}
              </span>
            )}
          </span>
        )}
        <ChevronDown
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...menuPanel}
            className="absolute bottom-full mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border/60 bg-popover p-3 shadow-2xl z-50 overflow-hidden"
            data-testid="task-progress-popover"
          >
            {totalTodos > 0 && (
              <div className="mb-2.5">
                <div className="flex items-center justify-between pb-1.5 border-b border-border/30 text-[11px] font-semibold text-foreground/75 uppercase tracking-wider">
                  <span>{todos?.title || 'Planned Steps'}</span>
                  <span className="tabular-nums text-muted-foreground font-mono">
                    {todosDone}/{totalTodos}
                  </span>
                </div>
                <div className="mt-1.5 max-h-48 overflow-y-auto chat-scroll space-y-1">
                  {todoList.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-start gap-2 py-0.5 text-xs"
                      data-status={t.status}
                    >
                      <span className="mt-0.5 shrink-0" aria-hidden>
                        {t.status === 'completed' ? (
                          <Check className="size-3.5 text-emerald-400" />
                        ) : t.status === 'in_progress' ? (
                          <Loader2 className="size-3.5 animate-spin text-primary" />
                        ) : t.status === 'cancelled' ? (
                          <Minus className="size-3.5 text-muted-foreground/40" />
                        ) : (
                          <Circle className="size-3.5 text-muted-foreground/40" />
                        )}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 leading-snug',
                          t.status === 'completed' && 'text-muted-foreground/60 line-through',
                          t.status === 'cancelled' && 'text-muted-foreground/40 line-through',
                          t.status === 'in_progress' && 'font-medium text-foreground',
                          t.status === 'pending' && 'text-muted-foreground',
                        )}
                      >
                        {t.content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {files.length > 0 && (
              <div className={cn(totalTodos > 0 && 'pt-2 border-t border-border/30')}>
                <div className="flex items-center justify-between pb-1 text-[11px] font-semibold text-foreground/75 uppercase tracking-wider">
                  <span>Modified Files</span>
                  <span className="tabular-nums text-muted-foreground font-mono">
                    {files.length}
                  </span>
                </div>
                <div className="mt-1 max-h-36 overflow-y-auto chat-scroll space-y-0.5">
                  {files.slice(0, 12).map((f) => (
                    <div key={f.path} className="flex items-center justify-between text-xs py-0.5 font-mono text-muted-foreground hover:text-foreground">
                      <span className="truncate max-w-[200px]" title={f.path}>
                        {f.path.split(/[/\\]/).pop()}
                      </span>
                      <span className="text-[10px] uppercase opacity-70">
                        {f.status}
                      </span>
                    </div>
                  ))}
                  {files.length > 12 && (
                    <div className="text-[10.5px] text-muted-foreground/60 italic pt-0.5">
                      +{files.length - 12} more files
                    </div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
