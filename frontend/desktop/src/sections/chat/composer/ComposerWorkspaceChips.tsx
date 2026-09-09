/* ── ComposerWorkspaceChips — folder + branch header inside the composer ─ */
/* ZCode parity: the message box carries its own context row — a folder    */
/* chip that opens a picker / recent-workspace menu, and the git branch    */
/* chip for that folder. The branch control is the same WorkspaceBranchChip */
/* the titlebar uses; only its placement flips (the composer sits at the    */
/* bottom, so the menu opens upward).                                      */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react';
import { toast } from 'sonner';
import { openFolderViaTauri, folderNameFromPath } from '@/api/folder';
import { WorkspaceBranchChip } from '@/components/workspace/WorkspaceBranchChip';
import { useWorkspacesStore } from '@/store/workspaces';
import { cn, workspaceBaseName } from '@/lib/utils';

export interface ComposerWorkspaceChipsProps {
  /** UI session id (sess_* / session_*) the folder gets bound to. */
  sessionId: string | null;
  /** Backend workbench id — the git endpoints resolve the workspace through it. */
  workbenchSessionId?: string | null;
  /** Folder this chat is currently bound to (null for a folderless Tasks chat). */
  workspacePath?: string | null;
  className?: string;
}

export function ComposerWorkspaceChips({
  sessionId,
  workbenchSessionId,
  workspacePath,
  className,
}: ComposerWorkspaceChipsProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const current = (workspacePath || '').trim();
  const label = current ? workspaceBaseName(current) : 'Open folder';

  /** Recents first (most recently used), then the bound path if it is not in the list. */
  const options = useMemo(() => {
    const sorted = [...workspaces].sort((a, b) =>
      (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''),
    );
    if (current && !sorted.some((w) => w.path === current)) {
      return [{ id: '__current', name: folderNameFromPath(current), path: current, lastUsedAt: '' }, ...sorted];
    }
    return sorted;
  }, [workspaces, current]);

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

  /**
   * Point this chat at a folder: bind the sidebar row (creates the Projects
   * group), make it the active workspace, then push the path to the backend
   * workbench session so the tools and the system prompt run there. Finally
   * drop the git caches so the branch chip re-reads the new repo.
   */
  const bindFolder = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || !sessionId) return;
    const normalized = trimmed.replace(/\\/g, '/');
    try {
      const [{ bindSessionToWorkspacePath }, { addWorkspace }] = await Promise.all([
        import('@/store/sessions'),
        import('@/store/workspaces'),
      ]);
      addWorkspace(normalized);
      const { session } = bindSessionToWorkspacePath(sessionId, normalized);
      const wbId = session.workbenchSessionId || workbenchSessionId || '';
      if (wbId) {
        try {
          await fetch('/api/workbench/sandbox-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: wbId,
              workspacePath: session.workspacePath || normalized,
            }),
          });
        } catch {
          /* best-effort — the next send re-syncs the workspace */
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['git'] });
      toast.success(`Working in ${folderNameFromPath(normalized)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open that folder');
    }
  };

  const handlePick = async () => {
    setPicking(true);
    try {
      const result = await openFolderViaTauri();
      if (result.cancelled || !result.path) return;
      setOpen(false);
      await bindFolder(result.path);
    } catch {
      toast.error('Folder picker is only available in the desktop app.');
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className={cn('flex items-center gap-1 min-w-0', className)}>
      <div ref={rootRef} className="relative min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!sessionId}
          aria-expanded={open}
          aria-haspopup="menu"
          title={current || 'Choose a project folder for this chat'}
          data-testid="composer-folder-chip"
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition max-w-[220px]',
            'hover:bg-muted text-muted-foreground hover:text-foreground',
            'border border-transparent hover:border-border/60',
            open && 'bg-muted/60 text-foreground',
            !sessionId && 'opacity-50 pointer-events-none',
          )}
        >
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>

        {open && (
          <div
            role="menu"
            data-testid="composer-folder-menu"
            className={cn(
              'absolute left-0 bottom-full mb-2 w-72 max-h-80 overflow-y-auto chat-scroll',
              'bg-card border border-border rounded-xl shadow-2xl p-1.5 z-50',
              'animate-in fade-in slide-in-from-bottom-2 duration-150',
            )}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void handlePick()}
              data-testid="composer-open-folder"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground transition hover:bg-muted"
            >
              <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
              {picking ? 'Choosing folder…' : 'Open folder…'}
            </button>
            <div className="mx-1.5 my-1 border-t border-border/40" />
            <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Projects
            </div>
            {options.length === 0 ? (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                No folders yet — open one to start.
              </div>
            ) : (
              options.map((w) => {
                const active = w.path === current;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={active}
                    onClick={() => {
                      setOpen(false);
                      void bindFolder(w.path);
                    }}
                    data-testid="composer-folder-pick"
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-muted',
                      active && 'bg-primary/10',
                    )}
                  >
                    <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground/90">
                        {w.name || workspaceBaseName(w.path)}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                        {w.path}
                      </span>
                    </span>
                    {active && <Check className="mt-0.5 size-3.5 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <WorkspaceBranchChip
        sessionId={workbenchSessionId || sessionId}
        repoPath={current || undefined}
        className="min-w-0"
        menuPlacement="up"
      />
    </div>
  );
}
