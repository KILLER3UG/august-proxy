/* ── Updates & Version — check for new releases and install them ── */

import { useState, useCallback } from 'react';
import { RotateCw, Download, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; version: string }
  | { status: 'available'; version: string; body?: string; date?: string }
  | { status: 'downloading'; progress: number }
  | { status: 'error'; message: string };

export function UpdateSection() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const isTauri =
    typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

  const checkForUpdates = useCallback(async () => {
    if (!isTauri) return;
    setState({ status: 'checking' });

    try {
      const updater = (window as any).__TAURI__.pluginUpdater;
      const update = await updater.checkUpdate();
      if (update.shouldUpdate && update.manifest) {
        setState({
          status: 'available',
          version: update.manifest.version,
          body: update.manifest.body,
          date: update.manifest.date,
        });
      } else {
        setState({ status: 'up-to-date', version: update.manifest?.version || '' });
      }
    } catch (err: any) {
      setState({ status: 'error', message: err?.message || 'Failed to check for updates' });
    }
  }, [isTauri]);

  const installUpdate = useCallback(async () => {
    if (!isTauri) return;
    setState({ status: 'downloading', progress: 0 });

    try {
      const updater = (window as any).__TAURI__.pluginUpdater;
      // InstallUpdate returns a promise that resolves when the update is
      // downloaded and staged. The app will restart after installation.
      await updater.installUpdate();
      // The app will restart automatically after install completes,
      // so we never reach here in practice.
    } catch (err: any) {
      setState({ status: 'error', message: err?.message || 'Failed to install update' });
    }
  }, [isTauri]);

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
                  August Proxy v2.0.1
                </p>
              </div>

              {state.status === 'idle' && (
                <Button variant="outline" size="sm" onClick={checkForUpdates}>
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
                <Button size="sm" onClick={installUpdate}>
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
                    onClick={checkForUpdates}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
