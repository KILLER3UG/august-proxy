/* ── FloatingRightPanel ─ right-side floating pill stack ────────────── */
/* Renders a stack of compact, expandable pills on the right edge of the   */
/* screen:                                                                  */
/*   - Todos pill  → live workbench todo list (X/Y counter + chevron)      */
/*   - Changes pill → git status (+N / -N)                                 */
/*   - Branch pill  → current branch + commit                              */
/* Each pill mirrors the small counter-chip pattern from the ZCode         */
/* reference (e.g. "Changes +27 -0"): a one-line header that expands       */
/* into a body on click.                                                    */
/*                                                                           */
/* Position: fixed, top-right of the viewport, vertically stacked, floating */
/* over the chat area — NOT part of the layout's right sidebar.            */

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
  Square,
  ArrowRight,
  Circle,
  Loader2,
  CheckSquare,
} from 'lucide-react';
import { gitApi } from '@/api/git';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkbenchTodo } from '@/types/workbench';

export interface FloatingRightPanelProps {
  /** Active session id (used to resolve the workspace cwd for git). */
  sessionId?: string;
  /** Workbench todos to render in the Todos pill. */
  todos?: WorkbenchTodo[];
  /** Optional className to override the floating position. */
  className?: string;
}

export function FloatingRightPanel({ sessionId, todos = [], className }: FloatingRightPanelProps) {
  return (
    <div
      className={cn(
        'fixed top-1/2 -translate-y-1/2 right-4 z-30',
        'flex flex-col gap-2 w-64 max-h-[80vh] overflow-visible',
        'pointer-events-none',
        className
      )}
      data-slot="floating-right-panel"
    >
      <TodosPill todos={todos} />
      <ChangesPill sessionId={sessionId} />
      <BranchPill sessionId={sessionId} />
    </div>
  );
}

/* ── Pill shell ──────────────────────────────────────────────────────── */

interface PillProps {
  label: string;
  summary?: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  /** Trailing accessory (e.g. a refresh button or a count chip). */
  trailing?: React.ReactNode;
}

function Pill({ label, summary, children, defaultOpen = false, trailing }: PillProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = !!children;
  return (
    <div
      className="rounded-full border border-white/[0.08] bg-card/85 backdrop-blur-md shadow-lg pointer-events-auto"
      data-slot="floating-pill"
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'text-[11.5px] text-foreground/90',
          hasBody && 'hover:bg-white/[0.04] transition-colors rounded-full',
          !hasBody && 'cursor-default'
        )}
        aria-expanded={hasBody ? open : undefined}
      >
        {hasBody ? (
          <span className="text-muted-foreground/60 shrink-0">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        ) : null}
        <span className="font-semibold tracking-tight shrink-0">{label}</span>
        {summary && (
          <span className="font-mono text-[10.5px] text-muted-foreground/80 min-w-0 truncate">
            {summary}
          </span>
        )}
        {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
      </button>
      {hasBody && open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-white/[0.05] rounded-b-3xl">
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Todos pill ──────────────────────────────────────────────────────── */

const TODOS_VISIBLE_LIMIT = 5;

function TodosPill({ todos }: { todos: WorkbenchTodo[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!todos || todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const allDone = done === total;
  const active = todos.find(t => t.status === 'in_progress');

  return (
    <Pill
      label="Todos"
      summary={`${done}/${total}`}
      defaultOpen
      trailing={
        allDone ? (
          <CheckSquare size={11} className="text-emerald-500" />
        ) : active ? (
          <Loader2 size={11} className="text-blue-500 animate-spin" />
        ) : (
          <Square size={11} className="text-muted-foreground/45" />
        )
      }
    >
      <div className="text-[11px] text-muted-foreground/85 mb-1.5 truncate">
        {allDone
          ? 'All steps complete'
          : active?.content
            ? truncate(active.content, 80)
            : `${total - done} step${total - done === 1 ? '' : 's'} pending`}
      </div>
      <TodosList todos={todos} expanded={expanded} onToggle={() => setExpanded(o => !o)} />
    </Pill>
  );
}

function TodosList({
  todos,
  expanded,
  onToggle,
}: {
  todos: WorkbenchTodo[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const total = todos.length;
  const visible = expanded ? todos : todos.slice(0, TODOS_VISIBLE_LIMIT);
  const overflow = total - visible.length;
  const activeIdx = todos.findIndex(t => t.status === 'in_progress');

  return (
    <div className="space-y-0.5">
      {visible.map((t) => {
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
      {overflow > 0 && (
        <button
          type="button"
          onClick={onToggle}
          className="text-[10px] text-muted-foreground/60 italic hover:text-foreground/80 pl-4 pt-0.5 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? `Hide ${overflow} waiting…` : `${overflow} waiting…`}
        </button>
      )}
    </div>
  );
}

/* ── Changes pill ────────────────────────────────────────────────────── */

function ChangesPill({ sessionId }: { sessionId?: string }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['git', 'status', sessionId],
    queryFn: () => gitApi.status(sessionId),
    refetchInterval: 30_000,
  });
  const s = status.data;
  const isRepo = !status.data?.error || (s?.files && s.files.length > 0);
  const fileCount = s?.files?.length ?? 0;
  const added = s?.added ?? 0;
  const removed = s?.removed ?? 0;

  if (!isRepo) return null;

  return (
    <Pill
      label="Changes"
      summary={
        fileCount > 0 ? (
          <>
            <Plus size={10} className="inline text-emerald-500" />
            <span className="text-emerald-500">{added}</span>
            <Minus size={10} className="inline text-rose-400 ml-1" />
            <span className="text-rose-400">{removed}</span>
          </>
        ) : (
          <span className="text-muted-foreground/60">clean</span>
        )
      }
      trailing={
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            qc.invalidateQueries({ queryKey: ['git'] });
          }}
          className="p-0.5 rounded hover:bg-white/10 text-muted-foreground/60"
          aria-label="Refresh git status"
        >
          <RefreshCw size={10} className={status.isFetching ? 'animate-spin' : ''} />
        </button>
      }
    >
      {fileCount === 0 ? (
        <div className="text-[10.5px] text-muted-foreground/60 italic py-0.5">
          Working tree clean
        </div>
      ) : (
        <div className="space-y-0.5 max-h-40 overflow-auto">
          {s!.files.slice(0, 12).map((f) => (
            <div key={f.path} className="flex items-center gap-1 text-[10.5px] truncate" title={f.path}>
              <span className="font-mono text-muted-foreground/60 w-5 text-right tabular-nums shrink-0">
                {f.added || ''}
              </span>
              <span className="font-mono text-muted-foreground/60 w-5 text-right tabular-nums shrink-0">
                {f.removed || ''}
              </span>
              <span className="truncate text-foreground/85 min-w-0">{f.path}</span>
            </div>
          ))}
          {s!.files.length > 12 && (
            <div className="text-[10px] text-muted-foreground/50 italic pt-0.5">
              + {s!.files.length - 12} more
            </div>
          )}
        </div>
      )}
    </Pill>
  );
}

/* ── Branch pill ─────────────────────────────────────────────────────── */

function BranchPill({ sessionId }: { sessionId?: string }) {
  const qc = useQueryClient();
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
  const [showMenu, setShowMenu] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

  const currentBranch = branch.data?.current;
  const branchList = branches.data?.branches || [];
  if (!currentBranch) return null;

  const handleCheckout = async (b: string) => {
    if (!sessionId) return;
    setShowMenu(false);
    try {
      await gitApi.checkout(sessionId, b);
      qc.invalidateQueries({ queryKey: ['git'] });
    } catch (err) {
      console.warn('[BranchPill] checkout failed:', (err as Error).message);
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
      console.warn('[BranchPill] commit failed:', (err as Error).message);
    }
  };

  return (
    <Pill
      label="Branch"
      summary={
        <span className="flex items-center gap-1">
          <GitBranch size={10} className="text-muted-foreground/70" />
          <span className="font-mono">{currentBranch}</span>
        </span>
      }
    >
      <div className="space-y-1.5 pt-0.5">
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
        <div className="flex items-center gap-1">
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
    </Pill>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}
