/* ── BranchMenuBody — git branch switcher menu ────────────────────────── */
/* Search, uncommitted count, create-branch and the Git Graph log, in one   */
/* body shared by the chat-side ChangesPill and the Git tools popover so     */
/* they render the exact same menu. The chip that wrapped it went out with   */
/* it went out with the titlebar status bar (dead code, deleted 0.18.x); a   */
/* branch control now has exactly one home.                                  */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, GitBranch, GitCommitHorizontal, Loader2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { gitApi } from '@/api/git';
import { cn } from '@/lib/utils';

/** Shared dropdown body: search + branch list + create + graph log. */
export function BranchMenuBody({
  sessionId,
  repoPath,
  current,
  onDone,
}: {
  sessionId: string | undefined;
  repoPath: string | undefined;
  current: string | null;
  /** Called after a successful switch/create (parent usually closes). */
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  // A blocked switch (uncommitted changes) parks here so the menu can offer
  // the GitHub-style choice: bring the changes across or leave them stashed.
  const [pendingSwitch, setPendingSwitch] = useState<{ name: string; files: string[] } | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const enabled = Boolean(sessionId || repoPath);
  const branches = useQuery({
    queryKey: ['git', 'branches', sessionId ?? null, repoPath ?? null],
    queryFn: () => gitApi.branches(sessionId, repoPath),
    enabled,
    retry: false,
  });
  // Uncommitted count under the current branch (Z.ai-style subtitle).
  const status = useQuery({
    queryKey: ['git', 'status', sessionId ?? null, repoPath ?? null],
    queryFn: () => gitApi.status(sessionId, repoPath),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
  const log = useQuery({
    queryKey: ['git', 'log', sessionId ?? null, repoPath ?? null],
    queryFn: () => gitApi.log(sessionId, 10, repoPath),
    enabled: enabled && graphOpen,
    retry: false,
  });

  const list = branches.data?.branches ?? [];
  const detached = Boolean(branches.data?.detached);
  const headSha = branches.data?.head ?? '';
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  }, [list, search]);
  const changedFiles = status.data?.files?.length ?? 0;

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  const finishSwitch = async (name: string, strategy?: 'leave' | 'transfer') => {
    setSwitching(name);
    try {
      const res = await gitApi.checkout(sessionId, name, repoPath, false, strategy);
      await qc.invalidateQueries({ queryKey: ['git'] });
      if (res?.warning) toast.warning(res.warning);
      else if (strategy === 'transfer') toast.success(`Switched to ${name} — changes brought over`);
      else if (strategy === 'leave') toast.success(`Switched to ${name} — changes left in the stash`);
      else toast.success(`Switched to ${name}`);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to switch branch');
    } finally {
      setSwitching(null);
      setPendingSwitch(null);
    }
  };

  const handleCheckout = async (name: string) => {
    if (name === current) {
      onDone?.();
      return;
    }
    if (!sessionId && !repoPath) return;
    setSwitching(name);
    try {
      const res = await gitApi.checkout(sessionId, name, repoPath);
      if (res?.dirty) {
        // Blocked by uncommitted changes — ask leave vs transfer instead of
        // failing the switch outright.
        setPendingSwitch({ name, files: res.files ?? [] });
        return;
      }
      await qc.invalidateQueries({ queryKey: ['git'] });
      toast.success(`Switched to ${name}`);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to switch branch');
    } finally {
      setSwitching(null);
    }
  };

  const handleCreate = async () => {
    const name = newBranch.trim();
    if (!name || switching !== null) return;
    setSwitching(name);
    try {
      await gitApi.checkout(sessionId, name, repoPath, true);
      await qc.invalidateQueries({ queryKey: ['git'] });
      toast.success(`Created and switched to ${name}`);
      setNewBranch('');
      setCreating(false);
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create branch');
    } finally {
      setSwitching(null);
    }
  };

  const logLines = (log.data?.log ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div data-testid="branch-menu-body">
      {/* Search */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-0.5">
        <Search className="size-3 shrink-0 text-muted-foreground/60" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search branches"
          data-testid="branch-search"
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <div className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        Branches
      </div>
      {pendingSwitch && (
        <div
          className="mx-1.5 mb-1.5 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-2xs"
          data-testid="branch-dirty-prompt"
        >
          <div className="font-medium text-foreground/90">
            Uncommitted changes block the switch to {pendingSwitch.name}.
          </div>
          {pendingSwitch.files.length > 0 && (
            <div className="mt-1 max-h-16 overflow-y-auto font-mono text-2xs text-muted-foreground chat-scroll">
              {pendingSwitch.files.slice(0, 20).map((f) => (
                <div key={f} className="truncate" title={f}>{f}</div>
              ))}
              {pendingSwitch.files.length > 20 && (
                <div>… +{pendingSwitch.files.length - 20} more</div>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              disabled={switching !== null}
              onClick={() => void finishSwitch(pendingSwitch.name, 'transfer')}
              className="flex-1 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              data-testid="branch-transfer"
            >
              Bring changes
            </button>
            <button
              type="button"
              disabled={switching !== null}
              onClick={() => void finishSwitch(pendingSwitch.name, 'leave')}
              className="flex-1 rounded-md border border-border/60 px-2 py-1 text-foreground transition hover:bg-muted disabled:opacity-50"
              data-testid="branch-leave"
            >
              Leave here
            </button>
            <button
              type="button"
              onClick={() => setPendingSwitch(null)}
              className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground"
              data-testid="branch-dirty-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="max-h-56 overflow-y-auto chat-scroll">
        {branches.isLoading && (
          <div className="flex items-center gap-2 px-2.5 py-3 text-2xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </div>
        )}
        {/* Detached HEAD — no branch is checked out; show where we are. */}
        {!branches.isLoading && detached && (
          <div
            className="flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs"
            data-testid="branch-detached"
          >
            <GitBranch className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate font-mono text-foreground">
              detached HEAD
            </span>
            {headSha && (
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">{headSha}</span>
            )}
          </div>
        )}
        {!branches.isLoading && !detached && filtered.length === 0 && (
          <div className="px-2.5 py-3 text-center text-2xs text-muted-foreground">
            {list.length === 0 ? 'No local branches found' : 'No matching branches'}
          </div>
        )}
        {filtered.map((b) => (
          <button
            key={b.name}
            type="button"
            role="option"
            aria-selected={b.current}
            disabled={switching !== null}
            onClick={() => void handleCheckout(b.name)}
            className={cn(
              'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-muted',
              b.current && 'bg-primary/10',
            )}
          >
            <GitBranch className="mt-0.5 size-3 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate font-mono text-xs', b.current ? 'text-foreground' : 'text-foreground/85')}>
                {b.name}
              </span>
              {b.current && changedFiles > 0 && (
                <span className="mt-0.5 block text-2xs text-muted-foreground" data-testid="branch-uncommitted">
                  Uncommitted changes: {changedFiles} {changedFiles === 1 ? 'file' : 'files'}
                </span>
              )}
              {/* Upstream sync state (↑ahead ↓behind) for the tracked branch. */}
              {b.upstream && ((b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0) && (
                <span className="mt-0.5 block font-mono text-2xs text-muted-foreground/80" data-testid="branch-track">
                  {b.upstream}
                  {(b.ahead ?? 0) > 0 && <span className="text-success-fg"> ↑{b.ahead}</span>}
                  {(b.behind ?? 0) > 0 && <span className="text-warning-fg"> ↓{b.behind}</span>}
                </span>
              )}
            </span>
            {switching === b.name ? (
              <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />
            ) : b.current ? (
              <Check className="mt-0.5 size-3 shrink-0" />
            ) : null}
          </button>
        ))}
      </div>
      {/* Create branch */}
      <div className="mx-1.5 my-1 border-t border-border/40" />
      {creating ? (
        <div className="px-1.5 pb-1">
          <input
            ref={createInputRef}
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setCreating(false);
                setNewBranch('');
              }
            }}
            placeholder="Branch name — Enter to create"
            data-testid="branch-create-input"
            className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
          />
        </div>
      ) : (
        <button
          type="button"
          data-testid="branch-create"
          onClick={() => setCreating(true)}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3 shrink-0" />
          Create and switch to new branch…
        </button>
      )}
      {/* Git Graph — recent commits log */}
      <button
        type="button"
        data-testid="git-graph"
        onClick={() => setGraphOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <GitCommitHorizontal className="size-3 shrink-0" />
        Git Graph
      </button>
      {graphOpen && (
        <div className="max-h-40 overflow-y-auto px-1.5 pb-1 chat-scroll" data-testid="git-graph-log">
          {log.isLoading && (
            <div className="flex items-center gap-2 px-2 py-2 text-2xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </div>
          )}
          {!log.isLoading && logLines.length === 0 && (
            <div className="px-2 py-2 text-2xs text-muted-foreground">No commits</div>
          )}
          {logLines.map((line) => {
            const sep = line.indexOf(' ');
            const sha = sep > 0 ? line.slice(0, sep) : line;
            const subject = sep > 0 ? line.slice(sep + 1) : '';
            return (
              <div key={sha} className="flex items-baseline gap-1.5 rounded px-1.5 py-0.5">
                <span className="shrink-0 font-mono text-2xs text-muted-foreground/60">{sha.slice(0, 7)}</span>
                <span className="min-w-0 truncate text-2xs text-foreground/85">{subject}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
