/* ── WorkspaceBranchChip — current git branch + switcher ───────────── */
/* Shown next to the open-folder control when the workspace is a git repo. */
/* The dropdown body (search, uncommitted count, create-branch, Git Graph  */
/* log) is exported as BranchMenuBody so the chat-side Git tools popover   */
/* renders the exact same menu.                                            */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, Loader2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { gitApi } from '@/api/git';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/store/workspaces';

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
        <Search className="size-3.5 shrink-0 text-muted-foreground/60" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search branches"
          data-testid="branch-search"
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Branches
      </div>
      {pendingSwitch && (
        <div
          className="mx-1.5 mb-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px]"
          data-testid="branch-dirty-prompt"
        >
          <div className="font-medium text-foreground/90">
            Uncommitted changes block the switch to {pendingSwitch.name}.
          </div>
          {pendingSwitch.files.length > 0 && (
            <div className="mt-1 max-h-16 overflow-y-auto font-mono text-[10px] text-muted-foreground chat-scroll">
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
          <div className="flex items-center gap-2 px-2.5 py-3 text-[11px] text-muted-foreground">
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
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{headSha}</span>
            )}
          </div>
        )}
        {!branches.isLoading && !detached && filtered.length === 0 && (
          <div className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
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
                <span className="mt-0.5 block text-[11px] text-muted-foreground" data-testid="branch-uncommitted">
                  Uncommitted changes: {changedFiles} {changedFiles === 1 ? 'file' : 'files'}
                </span>
              )}
              {/* Upstream sync state (↑ahead ↓behind) for the tracked branch. */}
              {b.upstream && ((b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0) && (
                <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/80" data-testid="branch-track">
                  {b.upstream}
                  {(b.ahead ?? 0) > 0 && <span className="text-emerald-400/80"> ↑{b.ahead}</span>}
                  {(b.behind ?? 0) > 0 && <span className="text-amber-400/80"> ↓{b.behind}</span>}
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
            <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </div>
          )}
          {!log.isLoading && logLines.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">No commits</div>
          )}
          {logLines.map((line) => {
            const sep = line.indexOf(' ');
            const sha = sep > 0 ? line.slice(0, sep) : line;
            const subject = sep > 0 ? line.slice(sep + 1) : '';
            return (
              <div key={sha} className="flex items-baseline gap-1.5 rounded px-1.5 py-0.5">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{sha.slice(0, 7)}</span>
                <span className="min-w-0 truncate text-[11px] text-foreground/85">{subject}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function WorkspaceBranchChip({
  sessionId,
  repoPath,
  className,
  menuPlacement = 'up',
}: {
  sessionId: string | null | undefined;
  /** Optional filesystem path when session workspace is not yet bound. */
  repoPath?: string | null;
  className?: string;
  /** Composer sits near the bottom — open upward. Titlebar opens downward. */
  menuPlacement?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null,
  );
  const resolvedPath = (repoPath || currentWorkspace?.path || '').trim() || undefined;
  const sid = (sessionId || '').trim() || undefined;

  const enabled = Boolean(sid || resolvedPath);

  const branch = useQuery({
    queryKey: ['git', 'branch', sid ?? null, resolvedPath ?? null],
    queryFn: () => gitApi.branch(sid, resolvedPath),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });

  const current = branch.data?.current;
  const notGitRepo = Boolean(
    !branch.isLoading &&
      branch.data &&
      branch.data.error &&
      !branch.data.current &&
      /not a git repository/i.test(branch.data.error),
  );

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

  if (!enabled) return null;
  // Hide only when we confirmed the folder is not a git work tree.
  // Transient "session not found" / path resolution misses must not blank the chip
  // when a concrete repoPath is available (backend falls back to it).
  if (notGitRepo) return null;
  if (!branch.isLoading && branch.isError && !resolvedPath) return null;
  if (!branch.isLoading && !branch.data?.current && !branch.isFetching && branch.data?.error && !resolvedPath) {
    return null;
  }

  const canSwitch = Boolean(sid || resolvedPath);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => {
          if (!canSwitch && !current) return;
          setOpen((v) => !v);
        }}
        disabled={branch.isLoading && !current}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition',
          'hover:bg-muted text-muted-foreground hover:text-foreground',
          'border border-transparent hover:border-border/60',
          open && 'bg-muted/60 text-foreground',
        )}
        title={current ? `Branch: ${current}` : 'Git branch'}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <GitBranch className="size-3.5 shrink-0" />
        {branch.isLoading && !current ? (
          <Loader2 className="size-3 animate-spin shrink-0" />
        ) : (
          <span className="truncate max-w-[140px] font-mono">{current || '—'}</span>
        )}
        {canSwitch && (
          <ChevronDown
            className={cn('size-3 transition-transform shrink-0', open && 'rotate-180')}
          />
        )}
      </button>

      {open && canSwitch && (
        <div
          className={cn(
            'absolute left-0 w-72 max-h-96 overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-150 chat-scroll',
            menuPlacement === 'up'
              ? 'bottom-full mb-2 slide-in-from-bottom-2'
              : 'top-full mt-2 slide-in-from-top-2',
          )}
          role="listbox"
        >
          <BranchMenuBody
            sessionId={sid}
            repoPath={resolvedPath}
            current={current ?? null}
            onDone={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
