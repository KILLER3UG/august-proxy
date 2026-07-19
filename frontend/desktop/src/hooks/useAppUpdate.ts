/* ── useAppUpdate — shared Tauri update check for settings + notifications ─ */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri-detect';
import { toast } from 'sonner';
import {
  IDLE_UPDATE_PROGRESS,
  useAppUpdateInstallStore,
  type AppUpdateProgress,
} from '@/store/app-update-install';

export type { AppUpdateProgress };

export interface AppUpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  if (!isTauri) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    date: update.date,
  };
}

/** Release Python/.pyd locks before NSIS overwrites bundled resources. */
async function stopBackendBeforeInstall(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await invoke<string>('stop_backend_for_update');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[update] stop_backend_for_update attempt ${attempt + 1} failed`, err);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  // Continue anyway — NSIS PREINSTALL also kills orphans — but log loudly.
  console.error('[update] stop_backend_for_update failed after retries', lastErr);
}

/**
 * Windows: `update.install()` quits the process before JS can `relaunch()`.
 * Schedule a detached waiter first (polls for NSIS completion marker — never
 * a fixed short sleep that can relaunch mid-copy). NSIS POSTINSTALL also
 * starts August when the install succeeds.
 */
async function schedulePostUpdateRelaunch(): Promise<void> {
  try {
    await invoke<string>('schedule_post_update_relaunch');
  } catch (err) {
    console.warn('[update] schedule_post_update_relaunch failed', err);
  }
}

export function useAppUpdate() {
  const queryClient = useQueryClient();
  const installing = useAppUpdateInstallStore((s) => s.installing);
  const progress = useAppUpdateInstallStore((s) => s.progress);
  const setInstalling = useAppUpdateInstallStore((s) => s.setInstalling);
  const setProgress = useAppUpdateInstallStore((s) => s.setProgress);
  const resetInstall = useAppUpdateInstallStore((s) => s.reset);

  const query = useQuery({
    queryKey: ['app-update'],
    queryFn: checkForAppUpdate,
    enabled: isTauri,
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const install = useCallback(async () => {
    if (!isTauri || !query.data) return;
    if (useAppUpdateInstallStore.getState().installing) return;

    setInstalling(true);
    setProgress({
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      phase: 'downloading',
    });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        toast.message('No update available');
        void queryClient.invalidateQueries({ queryKey: ['app-update'] });
        return;
      }

      let downloaded = 0;
      let contentLength: number | null = null;

      // Download first, then kill the backend, then install. On Windows NSIS
      // cannot overwrite resources/python/*.pyd while uvicorn still holds them;
      // downloadAndInstall races quit vs sidecar teardown.
      await update.download((event) => {
        switch (event.event) {
          case 'Started': {
            contentLength =
              typeof event.data.contentLength === 'number' && event.data.contentLength > 0
                ? event.data.contentLength
                : null;
            downloaded = 0;
            setProgress({
              percent: contentLength ? 0 : null,
              downloadedBytes: 0,
              totalBytes: contentLength,
              phase: 'downloading',
            });
            break;
          }
          case 'Progress': {
            downloaded += event.data.chunkLength;
            const percent =
              contentLength && contentLength > 0
                ? Math.min(100, Math.round((downloaded / contentLength) * 100))
                : null;
            setProgress({
              percent,
              downloadedBytes: downloaded,
              totalBytes: contentLength,
              phase: 'downloading',
            });
            break;
          }
          case 'Finished': {
            setProgress({
              percent: 100,
              downloadedBytes: contentLength ?? downloaded,
              totalBytes: contentLength ?? downloaded,
              phase: 'installing',
            });
            break;
          }
          default:
            break;
        }
      });
      setProgress({
        percent: 100,
        downloadedBytes: contentLength ?? downloaded,
        totalBytes: contentLength ?? downloaded,
        phase: 'installing',
      });
      await stopBackendBeforeInstall();
      // Must run before install(): on Windows the process is killed inside install().
      // Waiter polls for `.august-update-complete` (NSIS POSTINSTALL) up to ~3 min.
      await schedulePostUpdateRelaunch();

      // Paint the full-screen “restarting” overlay before the process exits so
      // users aren’t left staring at a frozen UI or a sudden quit.
      setProgress({
        percent: 100,
        downloadedBytes: contentLength ?? downloaded,
        totalBytes: contentLength ?? downloaded,
        phase: 'restarting',
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          window.setTimeout(resolve, 450);
        });
      });

      await update.install();

      // Non-Windows (and rare Windows paths where install() returns): relaunch now.
      // On Windows quiet NSIS, install() usually never returns — POSTINSTALL +
      // the scheduled waiter handle relaunch.
      try {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch {
        toast.success('Update installed — August should reopen shortly.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || 'Failed to install update');
      resetInstall();
    }
    // Do not reset on success — keep the restarting overlay until the process
    // exits (Windows) or relaunch() replaces the window.
  }, [query.data, queryClient, setInstalling, setProgress, resetInstall]);

  return {
    isTauri,
    available: query.data ?? null,
    checking: query.isFetching,
    installing,
    progress: installing ? progress : IDLE_UPDATE_PROGRESS,
    formatBytes,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['app-update'] }),
    install,
  };
}
