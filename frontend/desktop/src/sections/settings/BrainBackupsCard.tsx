import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDriveDownload, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  cancelBrainRestore,
  createBrainBackup,
  getBrainIntegrity,
  listBrainBackups,
  stageBrainRestore,
} from '@/api/api-client/brain-backup';

/**
 * Backups / integrity / restore for the brain database.
 *
 * This client existed complete but unwired since the 0.18 restyle dropped
 * the old "Memory files" card: the only bulk memory action left anywhere in
 * Settings was "Purge memory", so a user could delete everything and could
 * not back up, inspect, or restore anything. The backend takes a verified
 * rolling copy every 12h regardless; this card is the USER CONTROL the
 * removal took away.
 *
 * Authority rule (from the client): the server owns the backup list, the
 * integrity verdict, and what is staged for restore. Nothing is decided
 * here — a restore applies at next launch, never in place, and a staged
 * restore survives remounts.
 */
export function BrainBackupsCard() {
  const qc = useQueryClient();
  const [busyName, setBusyName] = useState<string | null>(null);

  const integrity = useQuery({ queryKey: ['brain', 'integrity'], queryFn: getBrainIntegrity });
  const backups = useQuery({ queryKey: ['brain', 'backups'], queryFn: listBrainBackups });

  const createMut = useMutation({
    mutationFn: () => createBrainBackup('manual'),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(`Backup created (${res.name ?? 'copy'})`);
      } else {
        toast.error(res.error || 'Backup failed');
      }
      void qc.invalidateQueries({ queryKey: ['brain', 'backups'] });
      void qc.invalidateQueries({ queryKey: ['brain', 'integrity'] });
    },
    onError: () => toast.error('Backup failed'),
  });

  const restoreMut = useMutation({
    mutationFn: (name: string) => stageBrainRestore(name),
    onSuccess: (res, name) => {
      if (res.ok) {
        toast.success('Restore staged — it applies the next time August starts.', {
          description: res.note ?? name,
        });
      } else {
        toast.error(res.error || 'Could not stage the restore');
      }
      setBusyName(null);
      void qc.invalidateQueries({ queryKey: ['brain', 'backups'] });
      void qc.invalidateQueries({ queryKey: ['brain', 'integrity'] });
    },
    onError: () => {
      setBusyName(null);
      toast.error('Could not stage the restore');
    },
  });

  const cancelMut = useMutation({
    mutationFn: cancelBrainRestore,
    onSuccess: (res) => {
      if (!res.cancelled) toast.error(res.error || 'Nothing was staged');
      void qc.invalidateQueries({ queryKey: ['brain', 'backups'] });
      void qc.invalidateQueries({ queryKey: ['brain', 'integrity'] });
    },
  });

  const pending = backups.data?.pendingRestore ?? integrity.data?.pendingRestore ?? null;
  const entries = backups.data?.backups ?? [];
  const healthy = integrity.data?.ok && integrity.data.exists;

  return (
    <section
      className="rounded-xl border border-border/60 bg-card/40 p-4"
      data-testid="brain-backups-card"
      aria-label="Memory backups"
    >
      <header className="flex items-center gap-2">
        <HardDriveDownload className="size-4 text-primary" />
        <h3 className="text-sm font-medium text-foreground">Backups &amp; restore</h3>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ['brain', 'integrity'] });
              void qc.invalidateQueries({ queryKey: ['brain', 'backups'] });
            }}
            aria-label="Refresh backups"
          >
            <RefreshCw className="size-3" />
          </Button>
          <Button
            size="sm"
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending}
            data-testid="brain-backup-now"
          >
            Back up now
          </Button>
        </div>
      </header>

      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        {integrity.isLoading ? (
          'Checking database integrity…'
        ) : integrity.isError ? (
          <>
            <TriangleAlert className="size-3 text-warning" />
            Could not read the integrity check.
          </>
        ) : healthy ? (
          <>
            <ShieldCheck className="size-3 text-success" />
            Database healthy{integrity.data?.backups != null ? ` · ${integrity.data.backups} verified copies` : ''}
          </>
        ) : (
          <>
            <TriangleAlert className="size-3 text-warning" />
            {integrity.data?.detail || 'No database yet.'}
          </>
        )}
      </p>

      {pending && (
        <div
          className="mt-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs"
          role="status"
          data-testid="brain-restore-pending"
        >
          <span className="flex-1 text-foreground">
            <strong>{pending}</strong> is staged — it replaces your memory at the next launch.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => cancelMut.mutate()}
            disabled={cancelMut.isPending}
            data-testid="brain-restore-cancel"
          >
            Cancel
          </Button>
        </div>
      )}

      <ul className="mt-3 space-y-1.5">
        {backups.isLoading && <li className="text-xs text-muted-foreground">Loading copies…</li>}
        {!backups.isLoading && entries.length === 0 && (
          <li className="text-xs text-muted-foreground">No copies yet.</li>
        )}
        {entries.map((entry) => (
          <li
            key={entry.name}
            className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="text-foreground">{entry.name}</span>
              <span className="ml-2 text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </span>
            </span>
            {entry.fromTheFuture ? (
              <span className="shrink-0 text-warning" title="Newer schema than this build">
                newer schema
              </span>
            ) : entry.healthy ? (
              <span className="shrink-0 text-success">verified</span>
            ) : (
              <span className="shrink-0 text-danger" title={entry.error}>
                unverified
              </span>
            )}
            {pending !== entry.name && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBusyName(entry.name);
                  restoreMut.mutate(entry.name);
                }}
                disabled={restoreMut.isPending && busyName === entry.name}
                data-testid={`brain-restore-${entry.name}`}
              >
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}