/* ── ComposerWorkspaceChips — the project picker beside the model chip ─── */
/* The project decision lives with the model/effort decision, in the composer
 * footer, not in a separate row inside the message card. The picker uses the
 * same popover grammar as the model menu: a header, a search field, a list of
 * choices, and a selected check. "No workspace" is a first-class choice: a
 * folderless chat can still run commands, with machine-wide reads and the
 * temp-only write policy the backend already applies. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Folder,
  FolderMinus,
  FolderPlus,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { openFolderViaTauri, folderNameFromPath } from '@/api/folder';
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
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const current = (workspacePath || '').trim();
  const label = current ? workspaceBaseName(current) || folderNameFromPath(current) : 'No workspace';

  /** Recents first (most recently used), then the bound path if it is not in the list. */
  const options = useMemo(() => {
    const sorted = [...workspaces].sort((a, b) =>
      (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''),
    );
    if (current && !sorted.some((w) => w.path === current)) {
      return [
        { id: '__current', name: folderNameFromPath(current), path: current, lastUsedAt: '' },
        ...sorted,
      ];
    }
    return sorted;
  }, [workspaces, current]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((w) => {
      const name = w.name || folderNameFromPath(w.path);
      return `${name} ${w.path}`.toLowerCase().includes(q);
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The sidebar's "Projects" row is a shortcut to this picker. It is useful
  // from a chat because the project decision belongs with the composer.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('august:open-project-picker', onOpen);
    return () => window.removeEventListener('august:open-project-picker', onOpen);
  }, []);

  useEffect(() => {
    if (!open) setQuery('');
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
          await api.post('/api/workbench/sandbox-mode', {
            sessionId: wbId,
            workspacePath: session.workspacePath || normalized,
          });
        } catch {
          /* best-effort — the next send re-syncs the workspace */
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['git'] });
      setOpen(false);
      toast.success(`Working in ${folderNameFromPath(normalized)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open that folder');
    }
  };

  /**
   * A folderless chat. The local session is moved to Unfiled and its path is
   * cleared; the backend session is told the same, so the next turn's prompt
   * and tool root stop naming the old folder. The tools still run — reads stay
   * machine-wide and writes go to the temp area, which is the backend's
   * existing no-workspace policy.
   */
  const clearWorkspace = async () => {
    if (!sessionId) return;
    try {
      const {
        useSessionsStore,
        updateSessionWorkspace,
        moveSessionToFolder,
      } = await import('@/store/sessions');
      const row = useSessionsStore
        .getState()
        .sessions.find((s) => s.id === sessionId || s.workbenchSessionId === sessionId);
      const id = row?.id ?? sessionId;
      const wbId = row?.workbenchSessionId || workbenchSessionId || '';
      updateSessionWorkspace(id, null);
      moveSessionToFolder(id, null);
      if (wbId) {
        await api.post('/api/workbench/sandbox-mode', {
          sessionId: wbId,
          workspacePath: '',
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['git'] });
      setOpen(false);
      toast.success('No workspace — commands run without a project folder');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not clear the project folder');
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
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <div ref={rootRef} className="relative min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!sessionId}
          aria-expanded={open}
          aria-haspopup="menu"
          title={current || 'No workspace — commands run without a project folder'}
          data-testid="composer-folder-chip"
          className={cn(
            'flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 text-[0.75rem] text-muted-foreground transition',
            'hover:bg-muted/50 hover:text-foreground',
            open && 'bg-muted/60 text-foreground',
            !sessionId && 'pointer-events-none opacity-50',
          )}
        >
          {current ? <Folder className="size-3 shrink-0" /> : <FolderMinus className="size-3 shrink-0" />}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>

        {open && (
          <div
            role="menu"
            data-testid="composer-folder-menu"
            className={cn(
              'absolute bottom-full left-0 z-50 mb-2 flex max-h-[420px] w-[304px] flex-col overflow-hidden',
              'rounded-xl border border-border/60 bg-popover shadow-2xl',
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-3">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold leading-5 text-foreground">
                Projects
              </span>
            </div>

            <div className="shrink-0 px-2 pb-1 pt-2">
              <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 transition-colors focus-within:border-primary/40">
                <Search className="size-3 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && query) {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery('');
                    }
                  }}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  data-testid="project-search"
                  className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear project search"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-1 chat-scroll">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!current}
                onClick={() => void clearWorkspace()}
                data-testid="project-no-workspace"
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                  !current ? 'bg-muted/40 text-foreground' : 'text-muted-foreground/85 hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <FolderMinus className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.8125rem] leading-5">No workspace</span>
                  <span className="block text-2xs leading-4 text-muted-foreground/65">
                    Commands run without a project folder
                  </span>
                </span>
                {!current ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
              </button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                role="menuitem"
                onClick={() => void handlePick()}
                data-testid="composer-open-folder"
                className="flex h-auto w-full items-center justify-start gap-2 rounded-none px-3 py-2 text-left text-[0.8125rem] text-muted-foreground/85 hover:bg-muted/40 hover:text-foreground"
              >
                <FolderPlus className="size-3.5 shrink-0" />
                {picking ? 'Choosing folder…' : 'Open folder…'}
              </Button>

              <div className="px-3 pb-1 pt-2 text-[0.625rem] font-medium leading-4 text-muted-foreground/70">
                Recent projects
              </div>

              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-2xs text-muted-foreground">
                  {options.length === 0 ? 'No projects yet — open a folder to start.' : 'No project matches that search.'}
                </div>
              ) : (
                filteredOptions.map((w) => {
                  const active = w.path === current;
                  return (
                    <Button
                      key={w.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={active}
                      onClick={() => {
                        setOpen(false);
                        void bindFolder(w.path);
                      }}
                      data-testid="composer-folder-pick"
                      className={cn(
                        'flex h-auto w-full items-start justify-start gap-2 rounded-none px-3 py-2 text-left transition-colors hover:bg-muted/40',
                        active && 'bg-muted/30',
                      )}
                    >
                      <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] leading-5 text-foreground/90">
                          {w.name || workspaceBaseName(w.path)}
                        </span>
                        <span className="block truncate font-mono text-2xs text-muted-foreground/65">
                          {w.path}
                        </span>
                      </span>
                      {active ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
                    </Button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
