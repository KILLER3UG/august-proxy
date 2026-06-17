/* ── FloatingRightPanel ─ right-side floating "Git tools" pill ───────── */
/* A single compact pill on the right edge of the screen that, when        */
/* expanded, reveals the workbench todo list plus git tooling (changes,   */
/* branch, commit). Mirrors the ZCode reference: a one-line counter chip   */
/* ("Changes +27 -0") that expands into a multi-section panel.            */
/*                                                                           */
/* Position: fixed, top-right of the viewport, floating over the chat      */
/* area — NOT a sidebar. Auto-hides entirely when there's no workbench     */
/* session and no git repo to show.                                        */
/*                                                                           */
/* Scrolling: the expanded body caps at ~70vh and scrolls; the file list   */
/* inside Changes and the todo list inside Progress each have their own    */
/* internal max-height so a long list scrolls within its own section.      */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch,
  GitCommit,
  Plus,
  Minus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Check,
  Circle,
  ArrowRight,
  Loader2,
  CheckSquare,
  Square,
} from 'lucide-react';
import { gitApi } from '@/api/git';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkbenchTodo } from '@/types/workbench';

export interface FloatingRightPanelProps {
  /** Active session id (used to resolve the workspace cwd for git). */
  sessionId?: string;
  /** Workbench todos to render in the Progress section. */
  todos?: WorkbenchTodo[];
  /** Optional className to override the floating position. */
  className?: string;
}

// Max heights for inner scroll containers so a long file list or todo list
// scrolls within its own section instead of pushing the pill off-screen.
const CHANGES_LIST_MAX_H = 'max-h-40';
const TODOS_LIST_MAX_H = 'max-h-40';
// Cap the entire expanded body so a 100-todo session doesn't push the pill
// past the viewport — the whole body scrolls when needed.
const BODY_MAX_H = 'max-h-[70vh]';

export function FloatingRightPanel({ sessionId, todos = [], className }: FloatingRightPanelProps) {
  const [open, setOpen] = useState(true);

  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['git', 'status', sessionId],
    queryFn: () => gitApi.status(sessionId),
    refetchInterval: 30_000,
  });
  const branch = useQuery({
    queryKey: ['git', 'branch', sessionId],
    queryFn: () => gitApi.branch(sessionId),
    refetchInterval: 30_000,
  });
  const branches = useQuery({
    queryKey: ['git', 'branches', sessionId],
    queryFn: () => gitApi.branches(sessionId),
    refetchInterval: 30_000,
  });

  const s = status.data;
  const currentBranch = branch.data?.current;
  const branchList = branches.data?.branches || [];
  const isRepo = !status.data?.error || (s?.files && s.files.length > 0);
  const fileCount = s?.files?.length ?? 0;
  const added = s?.added ?? 0;
  const removed = s?.removed ?? 0;
  const hasTodos = todos.length > 0;

  // Hide the entire pill when there's nothing to show.
  if (!isRepo && !hasTodos) return null;

  // Collapsed summary: "Changes +N -N" (or "N todos" if no git changes).
  const summary = isRepo
    ? fileCount > 0
      ? `${added > 0 ? '+' : ''}${added} ${removed > 0 ? '-' : ''}${removed}`
      : 'clean'
    : hasTodos
      ? `${todos.filter(t => t.status === 'completed').length}/${todos.length}`
      : '';

  return (
    <div
      className={cn(
        'fixed top-16 right-4 z-30 w-64',
        'rounded-2xl border border-white/[0.08] bg-card/85 backdrop-blur-md shadow-2xl',
        'pointer-events-auto overflow-hidden',
        className
      )}
      data-slot="floating-right-panel"
    >
      {/* Header — single pill trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] transition-colors"
        aria-expanded={open}
      >
        <span className="text-muted-foreground/60 shrink-0">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11.5px] font-semibold tracking-tight text-foreground/90 shrink-0">
          Git tools
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground/80 truncate">
          {summary}
        </span>
        <span className="ml-auto shrink-0 flex items-center gap-1.5">
          {isRepo && fileCount > 0 && (
            <span className="font-mono text-[10.5px] tabular-nums shrink-0">
              <Plus size={9} className="inline text-emerald-500" />
              <span className="text-emerald-500">{added}</span>
              <Minus size={9} className="inline text-rose-400 ml-1" />
              <span className="text-rose-400">{removed}</span>
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              qc.invalidateQueries({ queryKey: ['git'] });
            }}
            className="p-0.5 rounded hover:bg-white/10 text-muted-foreground/60"
            aria-label="Refresh git status"
            title="Refresh"
          >
            <RefreshCw size={10} className={status.isFetching ? 'animate-spin' : ''} />
          </button>
        </span>
      </button>

      {open && (
        <div className={cn('border-t border-white/[0.06] overflow-y-auto', BODY_MAX_H)}>
          {/* Section: Changes */}
          {isRepo && (
            <div className="px-3 py-2 border-b border-white/[0.04]">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold mb-1">
                Changes
              </div>
              {fileCount === 0 ? (
                <div className="text-[11px] text-muted-foreground/60 italic">
                  Working tree clean
                </div>
              ) : (
                <div className={cn('space-y-0.5 overflow-y-auto pr-1', CHANGES_LIST_MAX_H)}>
                  {s!.files.slice(0, 50).map((f) => {
                    const addedCount = f.added ?? 0;
                    const removedCount = f.removed ?? 0;
                    return (
                      <div
                        key={f.path}
                        className="flex items-center gap-1 text-[10.5px] truncate"
                        title={f.path}
                      >
                        {addedCount > 0 ? (
                          <span
                            aria-label={`${addedCount} line${addedCount === 1 ? '' : 's'} added`}
                            className="inline-flex items-center gap-0.5 font-mono tabular-nums text-emerald-500 w-9 justify-end shrink-0"
                          >
                            <Plus size={9} strokeWidth={3} />
                            <span>{addedCount}</span>
                          </span>
                        ) : (
                          <span className="w-9 shrink-0" />
                        )}
                        {removedCount > 0 ? (
                          <span
                            aria-label={`${removedCount} line${removedCount === 1 ? '' : 's'} removed`}
                            className="inline-flex items-center gap-0.5 font-mono tabular-nums text-rose-400 w-9 justify-end shrink-0"
                          >
                            <Minus size={9} strokeWidth={3} />
                            <span>{removedCount}</span>
                          </span>
                        ) : (
                          <span className="w-9 shrink-0" />
                        )}
                        <span className="truncate text-foreground/85 min-w-0">{f.path}</span>
                      </div>
                    );
                  })}
                  {s!.files.length > 50 && (
                    <div className="text-[10px] text-muted-foreground/50 italic pt-0.5">
                      + {s!.files.length - 50} more files
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Section: Branch + Commit */}
          {isRepo && currentBranch && (
            <BranchAndCommit
              sessionId={sessionId}
              currentBranch={currentBranch}
              branchList={branchList}
            />
          )}

          {/* Section: Progress (todos) */}
          {hasTodos && <ProgressSection todos={todos} />}
        </div>
      )}
    </div>
  );
}

/* ── Branch + Commit section ─────────────────────────────────────────── */

function BranchAndCommit({
  sessionId,
  currentBranch,
  branchList,
}: {
  sessionId?: string;
  currentBranch: string;
  branchList: Array<{ name: string; current?: boolean }>;
}) {
  const qc = useQueryClient();
  const [showMenu, setShowMenu] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

  const handleCheckout = async (b: string) => {
    if (!sessionId) return;
    setShowMenu(false);
    try {
      await gitApi.checkout(sessionId, b);
      qc.invalidateQueries({ queryKey: ['git'] });
    } catch (err) {
      console.warn('[FloatingRightPanel] checkout failed:', (err as Error).message);
    }
  };

  const handleCommit = async () => {
    const msg = commitMessage.trim();
    if (!msg || !sessionId) return;
    try {
      await gitApi.commit(sessionId, msg);
      setCommitMessage('');
      qc.invalidateQueries({ queryKey: ['git'] });
    } catch (err) {
      console.warn('[FloatingRightPanel] commit failed:', (err as Error).message);
    }
  };

  return (
    <div className="px-3 py-2 border-b border-white/[0.04] space-y-1.5">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold mb-1">
        Branch
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowMenu(o => !o)}
          className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-white/[0.04] hover:bg-white/[0.07] text-[11px]"
        >
          <span className="flex items-center gap-1.5 truncate">
            <GitBranch size={11} className="text-muted-foreground/70" />
            <span className="font-mono truncate">{currentBranch}</span>
          </span>
          <ChevronDown size={10} className="text-muted-foreground/60" />
        </button>
        {showMenu && branchList.length > 0 && (
          <div className="absolute z-20 mt-1 left-0 right-0 max-h-48 overflow-auto rounded-md border border-white/[0.08] bg-[#1c1c1c] shadow-2xl">
            {branchList.map((b) => (
              <button
                type="button"
                key={b.name}
                onClick={() => handleCheckout(b.name)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-white/[0.05]',
                  b.current && 'text-primary'
                )}
              >
                <GitBranch size={10} />
                <span className="truncate font-mono">{b.name}</span>
                {b.current && <Check size={10} className="ml-auto" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 pt-0.5">
        <input
          type="text"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Commit message…"
          disabled={!sessionId}
          className="flex-1 min-w-0 bg-white/[0.04] rounded-md px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:bg-white/[0.07] disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit();
          }}
        />
        <Button
          type="button"
          size="sm"
          onClick={handleCommit}
          disabled={!commitMessage.trim() || !sessionId}
          className="h-6 px-1.5"
        >
          <GitCommit size={10} />
        </Button>
      </div>
    </div>
  );
}

/* ── Progress (todos) section ────────────────────────────────────────── */

function ProgressSection({ todos }: { todos: WorkbenchTodo[] }) {
  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const allDone = done === total;
  const active = todos.find(t => t.status === 'in_progress');
  const activeIdx = todos.findIndex(t => t.status === 'in_progress');

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
          Progress
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground/70">
          {done}/{total}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px]">
        {allDone ? (
          <CheckSquare size={11} className="text-emerald-500 shrink-0" />
        ) : active ? (
          <Loader2 size={11} className="text-blue-500 animate-spin shrink-0" />
        ) : (
          <Square size={11} className="text-muted-foreground/45 shrink-0" />
        )}
        <span className="text-muted-foreground/80 truncate min-w-0">
          {allDone
            ? 'All steps complete'
            : active?.content
              ? truncate(active.content, 60)
              : `${total - done} step${total - done === 1 ? '' : 's'} pending`}
        </span>
      </div>
      {/* Scrollable todo list — the pill's body also scrolls, but having an
          inner scroll here means a long list stays inside the Progress
          section rather than pushing other sections off the screen. */}
      <div className={cn('space-y-0.5 overflow-y-auto pr-1', TODOS_LIST_MAX_H)}>
        {todos.map((t) => {
          const absoluteIndex = todos.indexOf(t);
          const code = `A${absoluteIndex + 1}`;
          const isActive = absoluteIndex === activeIdx;
          return (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-1.5 text-[11px] leading-snug py-0.5',
                isActive ? 'text-foreground' : 'text-muted-foreground/80'
              )}
              data-status={t.status}
            >
              <span
                aria-hidden
                className={cn(
                  'shrink-0 inline-flex justify-center w-3 pt-px tabular-nums',
                  t.status === 'in_progress' && 'text-blue-500',
                  t.status === 'completed' && 'text-emerald-500',
                  t.status === 'pending' && 'text-muted-foreground/45'
                )}
              >
                {t.status === 'completed' ? (
                  <Check size={10} strokeWidth={3} />
                ) : t.status === 'in_progress' ? (
                  <ArrowRight size={10} strokeWidth={3} />
                ) : (
                  <Circle size={8} strokeWidth={2} />
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 wrap-anywhere',
                  t.status === 'completed' && 'line-through text-muted-foreground/55'
                )}
              >
                <span className="font-mono text-muted-foreground/55 mr-1">{code}:</span>
                {t.content || `Step ${absoluteIndex + 1}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}
