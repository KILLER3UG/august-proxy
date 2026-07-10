import { useState, useEffect, useRef } from 'react';
import { FolderOpen, ChevronDown, Check, Plus, X } from 'lucide-react';
import { useStore } from '@nanostores/react';
import { cn } from '@/lib/utils';
import {
  $workspaces,
  $currentWorkspaceId,
  addWorkspace,
  removeWorkspace,
  setCurrentWorkspace,
  type Workspace,
} from '@/store/workspaces';
import { isTauri } from '@/lib/tauri-detect';

interface WorkspaceSelectorProps {
  sessionId: string | null;
  onWorkspaceChange?: (workspace: Workspace | null) => void;
}

export function WorkspaceSelector({ sessionId, onWorkspaceChange }: WorkspaceSelectorProps) {
  const [open, setOpen] = useState(false);
  const workspaces = useStore($workspaces);
  const currentWorkspaceId = useStore($currentWorkspaceId);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId) ?? null;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelectWorkspace = (ws: Workspace) => {
    setCurrentWorkspace(ws.id);
    setOpen(false);
    onWorkspaceChange?.(ws);
  };

  const handleOpenFolder = async () => {
    let path: string | null = null;

    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        path = await invoke<string | null>('select_directory');
      } catch (err) {
        console.error('[WorkspaceSelector] Tauri directory picker failed:', err);
      }
    } else {
      // Use the hidden directory input to open the native OS folder picker.
      // showDirectoryPicker() only returns the folder name, not the absolute
      // path, so we use <input type="file" webkitdirectory> instead — Chrome's
      // File.path exposes the full filesystem path the backend needs.
      dirInputRef.current?.click();
      return; // path will be set by the input's change handler
    }

    if (path) {
      const ws = addWorkspace(path);
      setOpen(false);
      onWorkspaceChange?.(ws);
    }
  };

  const handleDirPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Chrome exposes the full path on File.path; fall back to extracting from webkitRelativePath
    const fullPath = file.path
      || file.webkitRelativePath.slice(0, file.webkitRelativePath.indexOf('/'));
    if (fullPath) {
      const ws = addWorkspace(fullPath);
      setOpen(false);
      onWorkspaceChange?.(ws);
    }
    // Reset so the same directory can be re-selected
    e.target.value = '';
  };

  const handleRemoveWorkspace = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    removeWorkspace(ws.id);
    onWorkspaceChange?.(null);
  };

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={dirInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={handleDirPicked}
      />
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition',
          'hover:bg-muted text-muted-foreground hover:text-foreground',
          'border border-transparent hover:border-border/60',
          currentWorkspace
            ? 'text-foreground/80'
            : 'text-muted-foreground'
        )}
        title={currentWorkspace ? `${currentWorkspace.name}\n${currentWorkspace.path}` : 'Select workspace'}
      >
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="truncate max-w-[120px]">
          {currentWorkspace?.name ?? 'Open folder'}
        </span>
        <ChevronDown className={cn(
          'size-3 transition-transform',
          open && 'rotate-180'
        )} />
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-72 max-h-80 overflow-y-auto bg-card border border-border rounded-xl shadow-2xl p-1.5 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground uppercase font-semibold">
            Workspaces
          </div>

          {workspaces.length === 0 && (
            <div className="px-2.5 py-3 text-[11px] text-muted-foreground text-center">
              No workspaces yet. Open a folder to get started.
            </div>
          )}

          {workspaces.map(ws => (
            <button
              key={ws.id}
              onClick={() => handleSelectWorkspace(ws)}
              className={cn(
                'w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center gap-2 group',
                ws.id === currentWorkspaceId && 'bg-primary/10 text-primary'
              )}
            >
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{ws.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">{ws.path}</div>
              </div>
              {ws.id === currentWorkspaceId && (
                <Check className="size-3.5 shrink-0 text-primary" />
              )}
              <button
                onClick={(e) => handleRemoveWorkspace(e, ws)}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition"
                title="Remove workspace"
              >
                <X className="size-3" />
              </button>
            </button>
          ))}

          <div className="border-t border-border/70 mt-1 pt-1">
            <button
              onClick={() => { void handleOpenFolder(); }}
              className="w-full text-left px-2.5 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center gap-2 text-primary"
            >
              <Plus className="size-3.5" />
              <span>Open folder</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
