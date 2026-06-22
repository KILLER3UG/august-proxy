/* ── GitPanel ─ right-sidebar git tools (ZCode reference) ────────── */
/* Workspace-explorer rail: changes summary, branch selector, and commit. */
/* The workbench todo list is intentionally NOT shown here — it lives in   */
/* the chat area as a pill-style expandable component (TodoSummaryPill)   */
/* so the user can track task progress right next to the running turn.    */
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
  className?: string;
}

export function GitPanel({ sessionId, className }: GitPanelProps) {
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
      {/* 1. Changes summary */}
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
              <span className="inline-flex items-center gap-1 text-success">
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

      {/* 2. Branch selector + Commit */}
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
