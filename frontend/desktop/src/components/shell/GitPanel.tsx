/* ── GitPanel ─ right-sidebar git tools (ZCode reference) ────────── */
/* Mirrors the ZCode reference: a right-rail panel with three sections:    */
/*   1. Progress tracker (A1 → / A2 ○ / A3 ✓) — at the top so the user     */
/*      can track tasks at a glance without scrolling.                    */
/*   2. Changes summary (+N -N)                                            */
/*   3. Branch selector + Commit button                                    */
/*                                                                          */
/* Polls /api/git/status, /branch, /branches every 30s.                    */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, GitCommit, Plus, Minus, RefreshCw, ChevronDown, Check } from 'lucide-react';
import { gitApi } from '@/api/git';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface GitPanelProps {
  /** Active session id (used to resolve the workspace cwd). */
  sessionId?: string;
  /** Optional list of workbench todos to render as the progress tracker. */
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  className?: string;
}

const PROGRESS_VISIBLE_LIMIT = 5;
const PROGRESS_LABEL_CODE = (i: number) => `A${i + 1}`;

export function GitPanel({ sessionId, todos = [], className }: GitPanelProps) {
  const qc = useQueryClient();
  const [commitMessage, setCommitMessage] = useState('');
  const [showBranchMenu, setShowBranchMenu] = useState(false);

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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['git'] });
  };

  const handleCommit = async () => {
    const msg = commitMessage.trim();
    if (!msg || !sessionId) return;
    try {
      await gitApi.commit(sessionId, msg);
      setCommitMessage('');
      refresh();
    } catch (err) {
      console.warn('[GitPanel] commit failed:', (err as Error).message);
    }
  };

  const handleCheckout = async (b: string) => {
    if (!sessionId) return;
    setShowBranchMenu(false);
    try {
      await gitApi.checkout(sessionId, b);
      refresh();
    } catch (err) {
      console.warn('[GitPanel] checkout failed:', (err as Error).message);
    }
  };

  const s = status.data;
  const currentBranch = branch.data?.current;
  const branchList = branches.data?.branches || [];
  const isRepo = !status.data?.error || (s?.files && s.files.length > 0);

  return (
    <div className={cn('flex flex-col gap-3 p-3 text-xs', className)}>
      {/* 1. Progress tracker (top — always visible so the user can track tasks at a glance) */}
      {todos.length > 0 && <ProgressTracker todos={todos} />}

      {/* 2. Changes summary */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Changes</span>
          <button
            type="button"
            onClick={refresh}
            className="p-1 rounded hover:bg-white/10 text-muted-foreground/60"
            aria-label="Refresh git status"
          >
            <RefreshCw size={11} className={status.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
        {!isRepo ? (
          <div className="text-[11px] text-muted-foreground/60 italic">
            Not a git repository
          </div>
        ) : !s || s.files.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/60 italic">
            Working tree clean
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-2 font-mono tabular-nums">
              <span className="inline-flex items-center gap-1 text-emerald-500">
                <Plus size={11} /> {s.added}
              </span>
              <span className="inline-flex items-center gap-1 text-rose-400">
                <Minus size={11} /> {s.removed}
              </span>
              <span className="text-muted-foreground/60 ml-auto text-[10px]">
                {s.files.length} file{s.files.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-0.5 max-h-40 overflow-auto">
              {s.files.slice(0, 12).map((f) => (
                <div key={f.path} className="flex items-center gap-1.5 text-[11px] truncate">
                  <span className="font-mono text-muted-foreground/60 w-6 text-right tabular-nums">
                    {f.added || ''}
                  </span>
                  <span className="font-mono text-muted-foreground/60 w-6 text-right tabular-nums">
                    {f.removed || ''}
                  </span>
                  <span className="truncate text-foreground/85">{f.path}</span>
                </div>
              ))}
              {s.files.length > 12 && (
                <div className="text-[10px] text-muted-foreground/50 italic pt-0.5">
                  + {s.files.length - 12} more
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 3. Branch selector + Commit */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Branch &amp; commit</span>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowBranchMenu(o => !o)}
            disabled={!currentBranch}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.07] text-[12px] disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5 truncate">
              <GitBranch size={12} className="text-muted-foreground/70" />
              <span className="font-mono truncate">{currentBranch || '—'}</span>
            </span>
            <ChevronDown size={11} className="text-muted-foreground/60" />
          </button>
          {showBranchMenu && branchList.length > 0 && (
            <div className="absolute z-20 mt-1 left-0 right-0 max-h-56 overflow-auto rounded-md border border-white/[0.08] bg-[#1c1c1c] shadow-2xl">
              {branchList.map((b) => (
                <button
                  type="button"
                  key={b.name}
                  onClick={() => handleCheckout(b.name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 text-left text-[11.5px] hover:bg-white/[0.05]',
                    b.current && 'text-primary'
                  )}
                >
                  <GitBranch size={11} />
                  <span className="truncate font-mono">{b.name}</span>
                  {b.current && <Check size={11} className="ml-auto" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message…"
            disabled={!sessionId}
            className="flex-1 min-w-0 bg-white/[0.04] rounded-md px-2 py-1 text-[12px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:bg-white/[0.07] disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit();
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={handleCommit}
            disabled={!commitMessage.trim() || !sessionId}
            className="h-7 px-2"
          >
            <GitCommit size={12} />
          </Button>
        </div>
      </div>

    </div>
  );
}

/**
 * ProgressTracker — renders the workbench todo list in the right rail using
 * the ZCode reference style:
 *   - "Progress" label + "X/Y" counter header
 *   - Each row prefixed with a step code (A1, A2, A3...) and a status glyph
 *     (→ active / ○ pending / ✓ done)
 *   - Long item text wraps inside the row (no truncation)
 *   - "N waiting…" / "Hide N waiting" toggle for the overflow tail
 */
function ProgressTracker({ todos }: {
  todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}) {
  const [expanded, setExpanded] = useState(false);

  const total = todos.length;
  const done = todos.filter(t => t.status === 'completed').length;
  const visible = expanded ? todos : todos.slice(0, PROGRESS_VISIBLE_LIMIT);
  const overflow = total - visible.length;
  const activeIdx = todos.findIndex(t => t.status === 'in_progress');

  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-3" data-slot="progress-tracker">
      <div className="flex items-center justify-between mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
        <span>Progress</span>
        <span className="font-mono tabular-nums normal-case tracking-normal text-muted-foreground/60">
          {done}/{total}
        </span>
      </div>
      <div className="space-y-0.5">
        {visible.map((t) => {
          // The visible slice starts at index 0 even when collapsed, so
          // compute the absolute index in the full list to keep the codes
          // consistent ("A1" still means the first todo).
          const absoluteIndex = todos.indexOf(t);
          const code = PROGRESS_LABEL_CODE(absoluteIndex);
          const isActive = absoluteIndex === activeIdx;
          return (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-1.5 text-[11.5px] leading-snug',
                isActive ? 'text-foreground' : 'text-muted-foreground/75'
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
                  '✓'
                ) : t.status === 'in_progress' ? (
                  '→'
                ) : (
                  '○'
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
            onClick={() => setExpanded(o => !o)}
            className="text-[10px] text-muted-foreground/55 italic hover:text-foreground/80 pl-4 pt-0.5 transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? `Hide ${overflow} waiting…` : `${overflow} waiting…`}
          </button>
        )}
      </div>
    </div>
  );
}
