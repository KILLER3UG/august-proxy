/* ── Updates & Version — check for new releases and install them ── */

import { useState, useCallback } from 'react';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { RotateCw, Download, CheckCircle, AlertTriangle, RefreshCw, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBackendStatus } from '@/hooks/useBackendStatus';

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; version: string; body?: string; date?: string }
  | { status: 'downloading'; progress: number }
  | { status: 'error'; message: string };

export function UpdateSection() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [update, setUpdate] = useState<any>(null);
  const isTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const { status: backend, sync, isTauri: backendTauri } = useBackendStatus();

  const checkForUpdates = useCallback(async () => {
    if (!isTauri) return;
    setState({ status: 'checking' });

    try {
      const result = await checkUpdate();
      if (result) {
        setUpdate(result);
        setState({
          status: 'available',
          version: result.version,
          body: result.body,
          date: result.date,
        });
      } else {
        setUpdate(null);
        setState({ status: 'up-to-date', version: '' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', message: message || 'Failed to check for updates' });
    }
  }, [isTauri]);

  const doInstallUpdate = useCallback(async () => {
    if (!isTauri || !update) return;
    setState({ status: 'downloading', progress: 0 });

    try {
      await update.downloadAndInstall();
      // The app will restart automatically after install completes,
      // so we never reach here in practice.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', message: message || 'Failed to install update' });
    }
  }, [isTauri, update]);

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Updates & Version</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Check for new releases and update the desktop app.
      </p>

      {!isTauri ? (
        <div className="mt-6 rounded-xl border border-white/[0.06] bg-card/60 p-6">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Check for updates is only available in the desktop app.</span>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {/* Version info card */}
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Current Version</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  August Proxy v0.12.0
                </p>
              </div>

              {state.status === 'idle' && (
                <Button variant="outline" size="sm" onClick={() => { void checkForUpdates(); }}>
                  <RotateCw className="size-3.5 mr-1.5" />
                  Check for Updates
                </Button>
              )}

              {state.status === 'checking' && (
                <Button variant="outline" size="sm" disabled>
                  <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                  Checking…
                </Button>
              )}
            </div>
          </div>

          {/* Status card */}
          {state.status === 'up-to-date' && (
            <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-5">
              <div className="flex items-center gap-3">
                <CheckCircle className="size-5 text-green-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-400">Up to date</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    You're running the latest version.
                  </p>
                </div>
              </div>
            </div>
          )}

          {state.status === 'available' && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <Download className="size-5 text-amber-400 shrink-0" />
                    <p className="text-sm font-medium text-amber-400">
                      Update available: v{state.version}
                    </p>
                  </div>
                  {state.date && (
                    <p className="text-xs text-muted-foreground">
                      Released: {new Date(state.date).toLocaleDateString()}
                    </p>
                  )}
                  {state.body && (
                    <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-black/20 p-3">
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans">
                        {state.body}
                      </pre>
                    </div>
                  )}
                </div>
                <Button size="sm" onClick={() => { void doInstallUpdate(); }}>
                  <Download className="size-3.5 mr-1.5" />
                  Install
                </Button>
              </div>
            </div>
          )}

          {state.status === 'downloading' && (
            <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
              <div className="flex items-center gap-3">
                <RefreshCw className="size-5 text-muted-foreground animate-spin shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Downloading update…</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    The app will restart after installation.
                  </p>
                </div>
              </div>
            </div>
          )}

          {state.status === 'error' && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-red-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-red-400">Update check failed</p>
                  <p className="mt-0.5 text-xs text-muted-foreground break-words">
                    {state.message}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs"
                    onClick={() => { void checkForUpdates(); }}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Backend dependencies card (secondary to the app updater) */}
          <BackendDepsCard backend={backend} onSync={() => { void sync(); }} isTauri={backendTauri} />
        </div>
      )}
    </div>
  );
}

function BackendDepsCard({
  backend,
  onSync,
  isTauri,
}: {
  backend: ReturnType<typeof useBackendStatus>['status'];
  onSync: () => void;
  isTauri: boolean;
}) {
  if (!isTauri) return null;

  const proxyLabel =
    backend.proxy === 'up'
      ? 'Backend: up'
      : backend.proxy === 'down'
        ? 'Backend: down'
        : 'Backend: unknown';
  const proxyCls =
    backend.proxy === 'up'
      ? 'text-green-400'
      : backend.proxy === 'down'
        ? 'text-red-400'
        : 'text-muted-foreground';

  let syncLabel = 'Dependencies: up to date';
  let syncCls = 'text-green-400';
  if (backend.sync === 'syncing') {
    syncLabel = 'Syncing backend dependencies…';
    syncCls = 'text-amber-400';
  } else if (backend.sync === 'needs_setup') {
    syncLabel = 'Backend needs setup — run install.ps1 / install.sh';
    syncCls = 'text-amber-400';
  } else if (backend.sync === 'error') {
    syncLabel = `Sync failed: ${backend.syncError ?? 'unknown error'}`;
    syncCls = 'text-red-400';
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground flex items-center gap-2">
            <Database className="size-4 shrink-0" />
            Backend (Python)
          </p>
          <p className={`mt-1 text-xs ${proxyCls}`}>{proxyLabel}</p>
          <p className={`mt-0.5 text-xs ${syncCls}`}>{syncLabel}</p>
          {backend.lastError && (
            <p className="mt-1 text-[11px] text-red-400/80 break-words">
              Last error: {backend.lastError}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onSync}>
          Sync now
        </Button>
      </div>
    </div>
  );
}
