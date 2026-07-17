/* ── Inline save-point chip after mutating batches ────────────────────── */

import { useEffect, useState } from 'react';
import { Shield, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
  listWorkbenchSessionAgents,
} from '@/api/workbench';

/** Polls session agents meta for last checkpoint and renders the chip. */
export function SavePointBanner({
  workbenchSessionId,
}: {
  workbenchSessionId: string | null | undefined;
}) {
  const [meta, setMeta] = useState<{
    lastCheckpointId?: string;
    lastCheckpointLabel?: string;
  } | null>(null);

  useEffect(() => {
    if (!workbenchSessionId) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void listWorkbenchSessionAgents(workbenchSessionId)
        .then((data) => {
          if (cancelled) return;
          setMeta({
            lastCheckpointId: data.meta?.lastCheckpointId,
            lastCheckpointLabel: data.meta?.lastCheckpointLabel,
          });
        })
        .catch(() => {
          if (!cancelled) setMeta(null);
        });
    };
    load();
    const id = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [workbenchSessionId]);

  if (!meta?.lastCheckpointId && !meta?.lastCheckpointLabel) return null;
  return (
    <div className="px-4 pt-1">
      <SavePointChip
        workbenchSessionId={workbenchSessionId}
        checkpointId={meta.lastCheckpointId}
        label={meta.lastCheckpointLabel}
      />
    </div>
  );
}

export function SavePointChip({
  workbenchSessionId,
  label,
  checkpointId,
}: {
  workbenchSessionId: string | null | undefined;
  label?: string | null;
  checkpointId?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  if (!workbenchSessionId || (!label && !checkpointId)) return null;

  const restore = async () => {
    if (!workbenchSessionId) return;
    const ok = window.confirm(
      'Restore this save point? File changes after it will be overwritten.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      let id = checkpointId || '';
      if (!id) {
        const list = await listWorkbenchCheckpoints(workbenchSessionId);
        id = list[0]?.id || '';
      }
      if (!id) {
        toast.message('No save point available');
        return;
      }
      const res = await restoreWorkbenchCheckpoint(workbenchSessionId, id);
      toast.success(res.message || 'Save point restored');
    } catch (e) {
      toast.error(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="my-1.5 inline-flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1 text-[11px]"
      data-testid="save-point-chip"
    >
      <Shield className="size-3 text-emerald-400" />
      <span className="text-foreground/85">
        Save point{label ? `: ${label}` : ''}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-[10px]"
        disabled={busy}
        onClick={() => {
          void restore();
        }}
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RotateCcw className="size-3" />
        )}
        Restore
      </Button>
    </div>
  );
}

export default SavePointChip;
