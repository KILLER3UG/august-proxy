/* ── Brain-database backups ──────────────────────────────────────────── */
/* Wrappers for the /api/brain backup surface (backend: app/services/
 * brain_backup.py, wired in app/routers/brain_config.py).
 *
 * One authority rule applies here: the server health-checks every copy in
 * `listBrainBackups()` and owns what is staged for restore
 * (`pendingRestore`). Callers must read both from the response, never keep a
 * local guess — a restore only applies at next launch, so the staged state
 * survives a remount and component state would be the wrong home for it. */

import { api } from '../client';

/** One offline copy of the brain DB, already health-checked server-side.
 *  `healthy` is that copy's own `PRAGMA integrity_check` verdict and
 *  `fromTheFuture` means its schema version is newer than this build knows. */
export interface BrainBackupEntry {
  name: string;
  bytes: number;
  /** ISO timestamp of the copy (file mtime). */
  createdAt: string;
  healthy: boolean;
  appliedVersion: number;
  fromTheFuture: boolean;
  /** Present only when the copy could not be opened or verified. */
  error?: string;
}

export interface BrainBackupList {
  backups: BrainBackupEntry[];
  /** Retention rule: only the newest `keep` copies survive a backup. */
  keep: number;
  /** Backup name staged to apply on next launch, or null. */
  pendingRestore: string | null;
  directory: string;
}

export interface BrainBackupCreated {
  ok: boolean;
  name?: string;
  bytes?: number;
  appliedVersion?: number;
  /** Older copies the retention rule retired by this call. */
  pruned?: string[];
  error?: string;
}

export interface BrainRestoreStaged {
  ok: boolean;
  name?: string;
  /** Currently always the string `'next-launch'` — the swap happens at startup,
   *  never in place. Typed as a plain string because the server owns the value. */
  appliesOn?: string;
  note?: string;
  error?: string;
}

export interface BrainRestoreCancelled {
  ok: boolean;
  cancelled: boolean;
  error?: string;
}

export interface BrainIntegrity {
  ok: boolean;
  /** False when there is no database file yet — `detail` explains. */
  exists: boolean;
  /** 'ok' when healthy, otherwise the reason verbatim. */
  detail: string;
  path?: string;
  /** Healthy copies on disk. Absent when the DB does not exist. */
  backups?: number;
  pendingRestore?: string | null;
}

export function getBrainIntegrity(): Promise<BrainIntegrity> {
  return api.get<BrainIntegrity>('/api/brain/integrity');
}

export function listBrainBackups(): Promise<BrainBackupList> {
  return api.get<BrainBackupList>('/api/brain/backups');
}

export function createBrainBackup(reason: string): Promise<BrainBackupCreated> {
  return api.post<BrainBackupCreated>('/api/brain/backups', { reason });
}

export function stageBrainRestore(name: string): Promise<BrainRestoreStaged> {
  return api.post<BrainRestoreStaged>('/api/brain/backups/restore', { name });
}

export function cancelBrainRestore(): Promise<BrainRestoreCancelled> {
  return api.delete<BrainRestoreCancelled>('/api/brain/backups/restore');
}
