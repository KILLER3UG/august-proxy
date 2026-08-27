/**
 * useRevertAllChanges — shared "undo this turn's file changes" flow
 * (plan §4.5). Extracted from RightDrawerDiffSection.handleRevertAll so the
 * ChangesCard Undo button and the drawer's Revert-all share one code path:
 * restore the latest workbench save point when one exists, otherwise fall
 * back to `git restore -- .` for tracked files (untracked files are NOT
 * removed by the fallback — the confirm wording says "tracked file(s)").
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { gitApi } from '@/api/git';
import {
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
} from '@/api/workbench';
import { resolveWorkbenchSessionId } from '@/sections/chat/stream/session-id-map';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';

export function useRevertAllChanges(
  sessionId: string | null,
  fileCount: number,
  /** Extra side effect after a successful revert (e.g. clear drawer diff). */
  onReverted?: () => void,
) {
  const qc = useQueryClient();
  const [reverting, setReverting] = useState(false);
  const { state, confirm, handleConfirm, handleCancel } = useConfirmDialog();

  const revertAll = useCallback(() => {
    if (!sessionId || fileCount === 0 || reverting) return;
    const wbId = resolveWorkbenchSessionId(sessionId);
    void (async () => {
      setReverting(true);
      try {
        const list = await listWorkbenchCheckpoints(wbId).catch(() => []);
        const latest = list[0];
        if (latest?.id) {
          const ok = await confirm({
            title: 'Revert changes?',
            message: `Revert all ${fileCount} changed file${fileCount === 1 ? '' : 's'} back to the last save point?`,
            confirmLabel: 'Revert',
            variant: 'destructive',
          });
          if (!ok) return;
          const res = await restoreWorkbenchCheckpoint(wbId, latest.id);
          toast.success(res.message || 'Reverted to last save point');
        } else {
          const ok = await confirm({
            title: 'Discard changes?',
            message: `No save point found. Discard changes to ${fileCount} tracked file${fileCount === 1 ? '' : 's'} with git restore?`,
            confirmLabel: 'Discard',
            variant: 'destructive',
          });
          if (!ok) return;
          await gitApi.command(['restore', '--', '.'], sessionId);
          toast.success('Working tree restored');
        }
        onReverted?.();
        void qc.invalidateQueries({ queryKey: ['git', 'diff', sessionId] });
      } catch (err) {
        toast.error(
          `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setReverting(false);
      }
    })();
  }, [sessionId, fileCount, reverting, confirm, onReverted, qc]);

  const confirmDialog = (
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
  );

  return { revertAll, reverting, confirmDialog };
}
