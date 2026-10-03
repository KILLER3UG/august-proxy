import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { restoreWorkbenchCheckpoint, type WorkbenchCheckpoint } from '@/api/workbench';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { cn } from '@/lib/utils';

/**
 * SavePointChip — the turn's filesystem save points, on the transcript.
 *
 * The backend snapshots files before every mutating tool call, and until now
 * those save points were reachable only as the blunt "Revert all changes"
 * action in the changes card / diff drawer. This chip puts them ON the turn
 * they belong to: it shows how many were taken and offers "Restore files",
 * which rewinds the workspace to the FIRST checkpoint of the turn — the
 * state from before the turn touched anything. The transcript itself is
 * rewound separately (the user message's ← revert row); this chip is
 * deliberate about files only, so restoring never destroys the conversation
 * record.
 *
 * Silence by default: a turn that mutated nothing renders nothing.
 */
export function SavePointChip({
  checkpoints,
  sessionId,
  onRestored,
}: {
  checkpoints: WorkbenchCheckpoint[];
  sessionId?: string | null;
  /** Fired after a successful restore so parents can invalidate their diffs. */
  onRestored?: () => void;
}) {
  const qc = useQueryClient();
  const { state, confirm, handleConfirm, handleCancel } = useConfirmDialog();

  const restore = useMutation({
    mutationFn: (checkpointId: string) =>
      restoreWorkbenchCheckpoint(sessionId ?? '', checkpointId),
    onSuccess: (res) => {
      toast.success(res.message || 'Files restored to the save point');
      onRestored?.();
      void qc.invalidateQueries({ queryKey: ['git', 'diff', sessionId] });
    },
    onError: (err) =>
      toast.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  const onRestoreClick = useCallback(async () => {
    // The EARLIEST checkpoint of the turn is the pre-turn state.
    const first = checkpoints[checkpoints.length - 1];
    if (!first) return;
    const files = first.fileCount ?? 0;
    const ok = await confirm({
      title: 'Restore files?',
      message: `Rewind the workspace to before this turn — ${files} file${files === 1 ? '' : 's'} go back to their state at "${first.label || 'the save point'}". The conversation stays as it is.`,
      confirmLabel: 'Restore',
      variant: 'destructive',
    });
    if (!ok) return;
    restore.mutate(first.id);
  }, [checkpoints, confirm, restore]);

  if (checkpoints.length === 0) return null;

  const detail = (
    <div className="space-y-1" data-testid="save-point-detail">
      {checkpoints
        .slice()
        .reverse()
        .map((cp) => (
          <div key={cp.id} className="text-left">
            {cp.label || 'Save point'}
            {cp.fileCount != null ? ` · ${cp.fileCount} file${cp.fileCount === 1 ? '' : 's'}` : ''}
            {cp.createdAt ? ` · ${new Date(cp.createdAt).toLocaleTimeString()}` : ''}
          </div>
        ))}
    </div>
  );

  return (
    <>
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-2xs text-muted-foreground"
        data-testid="save-point-chip"
      >
        <ArchiveRestore className="size-2.5 shrink-0" aria-hidden />
        <SettingsTooltip
          side="top"
          className="max-w-xs"
          content={detail}
          trigger={(tp) => (
            <span {...tp} className="cursor-help">
              {checkpoints.length} save point{checkpoints.length === 1 ? '' : 's'}
            </span>
          )}
        />
        <button
          type="button"
          onClick={onRestoreClick}
          className={cn(
            'font-medium text-primary hover:underline',
            restore.isPending && 'opacity-50',
          )}
          data-testid="save-point-restore"
        >
          {restore.isPending ? 'Restoring…' : 'Restore files'}
        </button>
      </span>
      <ConfirmDialog
        open={state.open}
        title={state.title}
        message={state.message}
        confirmLabel={state.confirmLabel}
        cancelLabel={state.cancelLabel}
        variant={state.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </>
  );
}