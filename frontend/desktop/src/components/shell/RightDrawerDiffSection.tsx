/* ── RightDrawerDiffSection ─ full diff view ──────────────────────── */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, RefreshCw, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gitApi } from '@/api/git';
import { DiffView } from '@/components/chat/DiffView';
import { FileIcon } from '@/components/ui/FileIcon';
import { useRightDrawer } from './RightDrawerState';

export function RightDrawerDiffSection({ sessionId }: { sessionId: string | null }) {
  const qc = useQueryClient();
  const drawer = useRightDrawer();
  const storedDiff = drawer.diff;

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
        <Button
          variant="outline"
          size="sm"
          disabled={!sessionId || query.isFetching}
          onClick={() => qc.invalidateQueries({ queryKey: ['git', 'diff', sessionId] })}
        >
          <RefreshCw className={cn('size-3', query.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {!diff && query.isLoading && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          Loading diff…
        </div>
      )}

      {!diff && query.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive">
          {(query.error as Error).message}
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
