/* ── WorkspaceBranchChip — current git branch + switcher ───────────── */
/* Shown next to the open-folder control when the workspace is a git repo. */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, GitBranch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { gitApi } from '@/api/git';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/store/workspaces';

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
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
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
  const branches = useQuery({
    queryKey: ['git', 'branches', sid ?? null, resolvedPath ?? null],
    queryFn: () => gitApi.branches(sid, resolvedPath),
    enabled: enabled && open,
    retry: false,
  });

  const current = branch.data?.current;
  const list = branches.data?.branches ?? [];
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

  const handleCheckout = async (name: string) => {
    if (name === current) {
      setOpen(false);
      return;
    }
    if (!sid && !resolvedPath) {
      setOpen(false);
      return;
    }
    setSwitching(name);
    try {
      await gitApi.checkout(sid, name, resolvedPath);
      await qc.invalidateQueries({ queryKey: ['git'] });
      toast.success(`Switched to ${name}`);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to switch branch');
    } finally {
      setSwitching(null);
    }
  };

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
            'absolute left-0 w-64 max-h-72 overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in duration-150',
            menuPlacement === 'up'
              ? 'bottom-full mb-2 slide-in-from-bottom-2'
              : 'top-full mt-2 slide-in-from-top-2',
          )}
          role="listbox"
        >
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground uppercase font-semibold">
            Branches
          </div>
          {branches.isLoading && (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </div>
          )}
          {!branches.isLoading && list.length === 0 && (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground text-center">
              No local branches found
            </div>
          )}
          {list.map((b) => (
            <button
              key={b.name}
              type="button"
              role="option"
              aria-selected={b.current}
              disabled={switching !== null}
              onClick={() => {
                void handleCheckout(b.name);
              }}
              className={cn(
                'w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center gap-2',
                b.current && 'bg-primary/10 text-primary',
              )}
            >
              <GitBranch className="size-3 shrink-0 opacity-70" />
              <span className="flex-1 min-w-0 truncate font-mono">{b.name}</span>
              {switching === b.name ? (
                <Loader2 className="size-3 animate-spin shrink-0" />
              ) : b.current ? (
                <Check className="size-3 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
