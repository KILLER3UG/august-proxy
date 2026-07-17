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
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        toast.message('No update available');
        void queryClient.invalidateQueries({ queryKey: ['app-update'] });
        return;
      }
      await update.downloadAndInstall();
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
    }
  }, [query.data, queryClient]);

  return {
    isTauri,
    available: query.data ?? null,
    checking: query.isFetching,
    installing,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['app-update'] }),
    install,
  };
}
