/* ── useAppUpdate — shared Tauri update check for titlebar + dropdown ─ */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isTauri } from '@/lib/tauri-detect';
import { toast } from 'sonner';

export interface AppUpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

export interface AppUpdateProgress {
  /** 0–100 while downloading; null when size is unknown. */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  phase: 'idle' | 'downloading' | 'installing';
}

const IDLE_PROGRESS: AppUpdateProgress = {
  percent: null,
  downloadedBytes: 0,
  totalBytes: null,
  phase: 'idle',
};

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

export function useAppUpdate() {
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress>(IDLE_PROGRESS);

  const query = useQuery({
    queryKey: ['app-update'],
    queryFn: checkForAppUpdate,
    enabled: isTauri,
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const install = useCallback(async () => {
    if (!isTauri || !query.data) return;
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

      await update.downloadAndInstall((event) => {
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

      try {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch {
        toast.success('Update installed — restart August to finish.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || 'Failed to install update');
    } finally {
      setInstalling(false);
      setProgress(IDLE_PROGRESS);
    }
  }, [query.data, queryClient]);

  return {
    isTauri,
    available: query.data ?? null,
    checking: query.isFetching,
    installing,
    progress,
    formatBytes,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['app-update'] }),
    install,
  };
}
