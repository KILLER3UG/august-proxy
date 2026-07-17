/* ── useBackendStatus — backend supervisor status for Settings ───────── */
/* Polls `proxy_status`, reads the last spawn error, and exposes a
 * `syncBackendDeps` trigger so the UI can show backend up/down/setting-up
 * and kick off a dependency re-sync. Tauri-only; in the browser it
 * reports "unsupported" (no native supervisor).
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri-detect';

export type BackendSync = 'unknown' | 'up-to-date' | 'syncing' | 'needs_setup' | 'error';

export interface BackendStatus {
    proxy: 'up' | 'down' | 'unknown';
    port: number | null;
    lastError: string | null;
    sync: BackendSync;
    syncError: string | null;
    loading: boolean;
}

const INITIAL: BackendStatus = {
    proxy: 'unknown',
    port: null,
    lastError: null,
    sync: 'unknown',
    syncError: null,
    loading: false,
};

export function useBackendStatus() {
    const [status, setStatus] = useState<BackendStatus>(INITIAL);
    const tauri = isTauri;

    const refresh = useCallback(async () => {
        if (!tauri) return;
        setStatus((s) => ({ ...s, loading: true }));
        try {
            const proxy = (await invoke<string>('proxy_status'));
            let proxyState: BackendStatus['proxy'] = 'unknown';
            let port: number | null = null;
            if (proxy.startsWith('ok:')) {
                proxyState = 'up';
                port = Number(proxy.split(':')[1]) || null;
            } else {
                proxyState = 'down';
            }
            let lastError: string | null = null;
            try {
                lastError = (await invoke<string | null>('backend_last_error')) || null;
            } catch {
                lastError = null;
            }
            setStatus((s) => ({ ...s, proxy: proxyState, port, lastError }));
        } catch {
            setStatus((s) => ({ ...s, proxy: 'unknown' }));
        } finally {
            setStatus((s) => ({ ...s, loading: false }));
        }
    }, [tauri]);

    const sync = useCallback(async () => {
        if (!tauri) return;
        setStatus((s) => ({ ...s, sync: 'syncing', syncError: null }));
        try {
            const res = (await invoke<string>('sync_backend_deps'));
            if (res.startsWith('error')) {
                setStatus((s) => ({ ...s, sync: 'error', syncError: res.slice(6) }));
            } else if (res === 'needs_setup') {
                setStatus((s) => ({ ...s, sync: 'needs_setup' }));
            } else if (res === 'syncing' || res === 'synced') {
                setStatus((s) => ({ ...s, sync: res === 'synced' ? 'up-to-date' : 'syncing' }));
                setTimeout(() => { void refresh(); }, res === 'synced' ? 500 : 4000);
            } else {
                setStatus((s) => ({ ...s, sync: 'up-to-date' }));
            }
        } catch (e) {
            setStatus((s) => ({
                ...s,
                sync: 'error',
                syncError: e instanceof Error ? e.message : String(e),
            }));
        }
    }, [tauri, refresh]);

    useEffect(() => {
        if (!tauri) return;
        void refresh();
    }, [tauri, refresh]);

    return { status, refresh, sync, isTauri: tauri };
}
