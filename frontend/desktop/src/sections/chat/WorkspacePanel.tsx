import { useState, useEffect, useMemo, useRef } from 'react';
import { useSessionsStore, updateSessionWorkspace } from '@/store/sessions';
import { FolderGit2, ChevronRight, ChevronDown, Folder, FolderOpen, FileText, AlertCircle, Trash2, FolderSearch, Link2 } from 'lucide-react';
import { isTauri } from '@/lib/tauri-detect';
import { toast } from 'sonner';
import { useWorkspaceFiles } from '@/hooks/useWorkspaceFiles';
import { api } from '@/api/client';

interface FlatFileNode {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  isExpanded: boolean;
  sizeBytes?: number;
}

export function WorkspacePanel({ sessionId }: { sessionId: string | null }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSession = useMemo(() => sessions.find(s => s.id === sessionId), [sessions, sessionId]);
  const workspacePath = activeSession?.workspacePath || null;

  const [flatTree, setFlatTree] = useState<FlatFileNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Use React Query for root files
  const { data: rootFilesData, isLoading: loading, error: queryError } = useWorkspaceFiles(workspacePath);

  // Sync state with query results
  useEffect(() => {
    if (queryError) {
      setError(queryError.message);
      setFlatTree([]);
    } else if (rootFilesData) {
      setFlatTree(
        rootFilesData.files.map((f) => ({
          name: f.name,
          path: f.path,
          isDir: f.isDir,
          depth: 0,
          isExpanded: false,
          sizeBytes: f.sizeBytes,
        }))
      );
    } else if (!workspacePath) {
      setFlatTree([]);
      setError(null);
    }
  }, [workspacePath, rootFilesData, queryError]);

  const handleClear = () => {
    if (!sessionId) return;
    updateSessionWorkspace(sessionId, null);
    setFlatTree([]);
    setError(null);
    toast.info('Workspace cleared for this session');
  };

  const toggleFolder = async (node: FlatFileNode, idx: number) => {
    if (node.isExpanded) {
      // Collapse
      const prefix = node.path + '/';
      setFlatTree(prev => {
        const next = prev.filter(n => !n.path.startsWith(prefix));
        next[idx] = { ...node, isExpanded: false };
        return next;
      });
    } else {
      // Expand
      try {
        const data = await api.get<{ files: Array<{ name: string; path: string; isDir: boolean; sizeBytes?: number }> }>(
          `/api/workspace/files?path=${encodeURIComponent(node.path)}`
        );
        const subnodes = data.files.map((f) => ({
          name: f.name,
          path: f.path,
          isDir: f.isDir,
          depth: node.depth + 1,
          isExpanded: false,
          sizeBytes: f.sizeBytes,
        }));

        setFlatTree(prev => {
          const next = [...prev];
          next[idx] = { ...node, isExpanded: true };
          next.splice(idx + 1, 0, ...subnodes);
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Could not read folder: ${node.name}: ${message}`);
      }
    }
  };

  const handleSetWorkspace = (folderPath: string) => {
    if (!sessionId) return;
    updateSessionWorkspace(sessionId, folderPath);
    toast.success('Workspace updated to subfolder');
  };

  const handleReferenceFile = (filePath: string) => {
    const event = new CustomEvent('august-insert-composer-text', {
      detail: ` @read_file ${filePath} `,
    });
    window.dispatchEvent(event);
    toast.info(`Referenced: ${filePath.split('/').pop()}`);
  };

  // Hidden file input for native folder picker (browser fallback)
  const dirInputRef = useRef<HTMLInputElement>(null);

  const handleSelectFolder = async () => {
    let selectedPath: string | null = null;

    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        selectedPath = await invoke<string | null>('select_directory');
      } catch (err) {
        console.error('Failed to open Tauri directory dialog:', err);
      }
    } else {
      dirInputRef.current?.click();
      return;
    }

    if (!selectedPath) return;
    selectedPath = selectedPath.trim();
    if (!selectedPath) return;

    const normalizedPath = selectedPath.replace(/\\/g, '/');
    const folderName = normalizedPath.split('/').pop() || 'workspace';

    const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);

    try {
      await api.get<{ files: Array<{ name: string; path: string; isDir: boolean }> }>(
        `/api/workspace/files?path=${encodeURIComponent(normalizedPath)}`
      );

      toast.success(`Connected to workspace: ${folderName}`, { id: toastId });

      if (sessionId) {
        updateSessionWorkspace(sessionId, normalizedPath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Access failed: ${message}`, { id: toastId });
    }
  };

  const handleDirPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fullPath = file.path
      || file.webkitRelativePath.slice(0, file.webkitRelativePath.indexOf('/'));
    if (!fullPath) return;
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const folderName = normalizedPath.split('/').pop() || 'workspace';
    const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);
    void (async () => {
      try {
        await api.get<{ files: Array<{ name: string; path: string; isDir: boolean }> }>(
          `/api/workspace/files?path=${encodeURIComponent(normalizedPath)}`
        );
        toast.success(`Connected to workspace: ${folderName}`, { id: toastId });
        if (sessionId) updateSessionWorkspace(sessionId, normalizedPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Access failed: ${message}`, { id: toastId });
      }
    })();
    e.target.value = '';
  };

  const formatBytes = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return '';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="flex flex-col h-full bg-sidebar text-sm">
      <input
        ref={dirInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={handleDirPicked}
      />
      {/* Header */}
      <div className="p-3 border-b border-border/40 flex items-center justify-between shrink-0 bg-background">
        <div className="flex items-center gap-2">
          <FolderGit2 className="size-4 text-warning/80" />
          <div className="flex flex-col">
            <span className="font-semibold text-foreground/80 text-[13px]">Workspace Explorer</span>
            {workspacePath && (
              <span className="text-[9px] text-muted-foreground/50 font-mono truncate max-w-[180px]" title={workspacePath}>
                {workspacePath.split(/[/\\]/).pop()}
              </span>
            )}
          </div>
        </div>
        {workspacePath && (
          <button
            onClick={handleClear}
            title="Disconnect Workspace"
            className="p-1 hover:bg-white/5 rounded text-muted-foreground hover:text-destructive transition"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      {/* Path Display / Connect Fallback */}
      <div className="p-3 border-b border-border/10 bg-sidebar shrink-0">
        {workspacePath ? (
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] text-muted-foreground/50 font-mono truncate" title={workspacePath}>
              {workspacePath}
            </span>
          </div>
        ) : (
          <div className="py-4 px-2 text-center text-muted-foreground/60 space-y-3">
            <p className="text-[12.5px]">No folder connected to this session.</p>
            <input
              type="text"
              placeholder="Paste path & press Enter (e.g. C:/my-project)..."
              className="w-full h-8 px-2.5 rounded border border-border/40 bg-muted/20 text-xs text-foreground placeholder:text-muted-foreground/45 outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary transition"
              onKeyDown={(e) => {
                void (async () => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      const normalized = val.replace(/\\/g, '/');
                      const folderName = normalized.split('/').pop() || 'workspace';
                      const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);
                      try {
                        await api.get<{ files: Array<{ name: string; path: string; isDir: boolean }> }>(
                          `/api/workspace/files?path=${encodeURIComponent(normalized)}`
                        );
                        toast.success(`Connected to workspace: ${folderName}`, { id: toastId });
                        if (sessionId) {
                          updateSessionWorkspace(sessionId, normalized);
                          (e.target as HTMLInputElement).value = '';
                        }
                      } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        toast.error(`Access failed: ${message}`, { id: toastId });
                      }
                    }
                  }
                })();
              }}
            />
            <div className="relative flex items-center justify-center my-1">
              <span className="w-full h-[1px] bg-border/20 absolute" />
              <span className="text-[9px] uppercase px-2 bg-sidebar text-muted-foreground/60 relative font-bold">or</span>
            </div>
            <button
              onClick={() => { void handleSelectFolder(); }}
              className="w-full py-1.5 px-3 rounded-lg bg-primary text-primary-foreground font-semibold text-[10.5px] hover:opacity-95 active:scale-95 transition flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <FolderGit2 className="size-3.5" />
              <span>Select Folder</span>
            </button>
          </div>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex items-start gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 rounded-lg m-3 p-2.5">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {workspacePath && !error && (
          <>
            {flatTree.length === 0 && !loading && (
              <div className="py-12 text-center text-muted-foreground/40 text-[11px] italic">
                No files found in this directory
              </div>
            )}
            {flatTree.map((node, i) => (
              <div
                key={node.path}
                className="group flex items-center justify-between rounded px-1.5 py-1 hover:bg-white/5 transition cursor-pointer text-foreground/80 hover:text-foreground"
                style={{ paddingLeft: `${node.depth * 10 + 6}px` }}
                onClick={() => { if (node.isDir) { void toggleFolder(node, i); } }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {node.isDir ? (
                    <>
                      {node.isExpanded ? (
                        <ChevronDown className="size-3 text-muted-foreground/60 shrink-0" />
                      ) : (
                        <ChevronRight className="size-3 text-muted-foreground/60 shrink-0" />
                      )}
                      {node.isExpanded ? (
                        <FolderOpen className="size-3.5 text-warning/80 shrink-0" />
                      ) : (
                        <Folder className="size-3.5 text-warning/80 shrink-0" />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="w-3" />
                      <FileText className="size-3.5 text-muted-foreground/60 shrink-0" />
                    </>
                  )}
                  <span className="truncate text-[13px] font-mono">{node.name}</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!node.isDir && node.sizeBytes !== undefined && (
                    <span className="text-[9px] text-muted-foreground/45 font-mono">
                      {formatBytes(node.sizeBytes)}
                    </span>
                  )}

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {node.isDir ? (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleSetWorkspace(node.path);
                        }}
                        title="Set as active workspace path"
                        className="p-0.5 hover:bg-white/10 rounded text-primary hover:text-primary-foreground transition"
                      >
                        <FolderSearch className="size-3" />
                      </button>
                    ) : (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleReferenceFile(node.path);
                        }}
                        title="Reference in chat"
                        className="p-0.5 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground transition"
                      >
                        <Link2 className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {loading && (
              <div className="py-4 text-center text-muted-foreground/50 text-[12px] animate-pulse">
                Loading files...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
