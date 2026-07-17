/* ── Updates & Version — check for new releases and install them ── */

import { useEffect, useState } from 'react';
import { RotateCw, Download, CheckCircle, AlertTriangle, RefreshCw, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBackendStatus } from '@/hooks/useBackendStatus';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { isTauri } from '@/lib/tauri-detect';

export function UpdateSection() {
  const { available, checking, installing, refresh, install } = useAppUpdate();
  const { status: backend, sync, isTauri: backendTauri } = useBackendStatus();
  const [currentVersion, setCurrentVersion] = useState<string>('…');
  const [manualChecked, setManualChecked] = useState(false);

  useEffect(() => {
    if (!isTauri) {
      setCurrentVersion('web');
      return;
    }
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setCurrentVersion(await getVersion());
      } catch {
        setCurrentVersion('unknown');
      }
    })();
  }, []);

  const onCheck = () => {
    setManualChecked(true);
    void refresh();
  };

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Updates & Version</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Check for new releases published on GitHub and update the desktop app.
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
          <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Current Version</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  August Proxy v{currentVersion}
                </p>
              </div>

              <Button
                variant="outline"
                size="sm"
                disabled={checking || installing}
                onClick={onCheck}
              >
                {checking ? (
                  <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5 mr-1.5" />
                )}
                {checking ? 'Checking…' : 'Check for Updates'}
              </Button>
            </div>
          </div>

          {!available && manualChecked && !checking && (
            <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-5">
              <div className="flex items-center gap-3">
                <CheckCircle className="size-5 text-green-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-400">Up to date</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    You&apos;re running the latest version.
                  </p>
                </div>
              </div>
            </div>
          )}

          {available && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <Download className="size-5 text-amber-400 shrink-0" />
                    <p className="text-sm font-medium text-amber-400">
                      Update available: v{available.version}
                    </p>
                  </div>
                  {available.date && (
                    <p className="text-xs text-muted-foreground">
                      Released: {new Date(available.date).toLocaleDateString()}
                    </p>
                  )}
                  {available.body && (
                    <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-black/20 p-3">
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans">
                        {available.body}
                      </pre>
                    </div>
                  )}
                </div>
                <Button size="sm" disabled={installing} onClick={() => { void install(); }}>
                  <Download className="size-3.5 mr-1.5" />
                  {installing ? 'Installing…' : 'Install'}
                </Button>
              </div>
            </div>
          )}

          {installing && (
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
