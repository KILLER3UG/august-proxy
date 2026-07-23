/* ── RightDrawerDiffSection ─ full diff view ──────────────────────── */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, RefreshCw, ArrowRight, Check, Undo2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gitApi } from '@/api/git';
import {
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
} from '@/api/workbench';
import { DiffView } from '@/components/chat/DiffView';
import { FileIcon } from '@/components/ui/FileIcon';
import {
  useRightDrawer,
  closeRightDrawerSection,
  clearRightDrawerDiff,
} from './RightDrawerState';
import { resolveWorkbenchSessionId } from '@/sections/chat/stream/session-id-map';

export function RightDrawerDiffSection({ sessionId }: { sessionId: string | null }) {
  const qc = useQueryClient();
  const drawer = useRightDrawer();
  const storedDiff = drawer.diff;
  const [reverting, setReverting] = useState(false);

  const query = useQuery({
    queryKey: ['git', 'diff', sessionId],
    queryFn: () => (sessionId ? gitApi.diff(sessionId) : Promise.resolve(null)),
    enabled: !!sessionId,
    retry: false,
  });

  const diff = query.data || storedDiff || undefined;
  const files = diff?.files?.filter((file) => file.added > 0 || file.removed > 0 || file.status || file.diff?.trim()) ?? [];
  const added = diff?.added ?? files.reduce((sum, file) => sum + file.added, 0);
  const removed = diff?.removed ?? files.reduce((sum, file) => sum + file.removed, 0);

  const refreshDiff = () => {
    void qc.invalidateQueries({ queryKey: ['git', 'diff', sessionId] });
  };

  /** Keep every change: nothing to do on disk — dismiss the review pane. */
  const handleKeepAll = () => {
    clearRightDrawerDiff();
    closeRightDrawerSection('diff');
    toast.success('Changes kept');
  };

  /** Revert every change: restore the latest save point (falls back to
   *  `git restore .` for tracked files when no save point exists). */
  const handleRevertAll = () => {
    if (!sessionId || files.length === 0 || reverting) return;
    const wbId = resolveWorkbenchSessionId(sessionId);
    void (async () => {
      setReverting(true);
      try {
        const list = await listWorkbenchCheckpoints(wbId).catch(() => []);
        const latest = list[0];
        if (latest?.id) {
          const ok = window.confirm(
            `Revert all ${files.length} changed file${files.length === 1 ? '' : 's'} back to the last save point?`,
          );
          if (!ok) return;
          const res = await restoreWorkbenchCheckpoint(wbId, latest.id);
          toast.success(res.message || 'Reverted to last save point');
        } else {
          const ok = window.confirm(
            `No save point found. Discard changes to ${files.length} tracked file${files.length === 1 ? '' : 's'} with git restore?`,
          );
          if (!ok) return;
          await gitApi.command(['restore', '--', '.'], sessionId);
          toast.success('Working tree restored');
        }
        clearRightDrawerDiff();
        refreshDiff();
      } catch (err) {
        toast.error(
          `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setReverting(false);
      }
    })();
  };

  return (
    <div className="h-full space-y-3 drawer-section-text">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">
            {diff ? `${files.length} changed file${files.length === 1 ? '' : 's'}` : 'No diff loaded yet'}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs tabular-nums">
            {added > 0 && <span className="text-success">+{added}</span>}
            {removed > 0 && <span className="text-danger">-{removed}</span>}
            {!added && !removed && <span className="text-muted-foreground/60">0</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={!sessionId || query.isFetching}
            onClick={refreshDiff}
            title="Reload the working-tree diff"
          >
            <RefreshCw className={cn('size-3', query.isFetching && 'animate-spin')} />
            Refresh
          </Button>
          {files.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleKeepAll}
                title="Keep all changes and close the review"
              >
                <Check className="size-3" />
                Keep all
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!sessionId || reverting}
                onClick={handleRevertAll}
                className="text-danger hover:text-danger"
                title="Revert all changes to the last save point"
              >
                {reverting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Undo2 className="size-3" />
                )}
                Revert all
              </Button>
            </>
          )}
        </div>
      </div>

      {!diff && query.isLoading && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          Loading diff…
        </div>
      )}

      {!diff && query.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive">
          {(query.error).message}
        </div>
      )}

      {files.length === 0 && diff && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          Working tree is clean.
        </div>
      )}

      <div className="space-y-3">
        {files.map((file) => {
          const selected = drawer.selectedDiffPath === file.path;
          return (
            <div
              key={file.path}
              className={cn(
                'overflow-hidden rounded-lg border bg-black/20',
                selected ? 'border-primary/50' : 'border-white/[0.06]'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between gap-2 border-b px-2.5 py-2',
                  selected ? 'border-primary/30 bg-primary/10' : 'border-white/[0.05] bg-white/[0.025]'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <FileIcon name={file.path} size={13} className="shrink-0" />
                  <span className="truncate font-mono text-xs text-foreground/85" title={file.path}>
                    {file.path}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {file.status && <Badge variant="secondary" className="text-[10px]">{file.status}</Badge>}
                  <span className="font-mono text-xs text-success">+{file.added}</span>
                  <span className="font-mono text-xs text-danger">-{file.removed}</span>
                  <ArrowRight className="size-3 text-muted-foreground/50" />
                  <FileText className="size-3 text-muted-foreground/50" />
                </div>
              </div>

              {file.diff?.trim() ? (
                <DiffView diff={file.diff} maxLines={240} />
              ) : (
                <div className="p-3 text-center text-muted-foreground/60">No diff content available.</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
