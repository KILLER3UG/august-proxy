/* ── About — app identity, update checks, and release notes ─────────── */
/* The update button used to live only in a hidden "Updates" section and
 * appeared solely when a newer release was detected, so it looked absent
 * even when checking. This page always shows a Check now control, surfaces
 * check ERRORS distinctly from "up to date", and offers Update now /
 * Release notes like the reference design. */

import { useEffect, useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Database,
  Download,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useBackendStatus } from '@/hooks/useBackendStatus';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { isTauri } from '@/lib/tauri-detect';
import { openExternal } from '@/lib/tauri-shell';

const RELEASES_URL = 'https://github.com/KILLER3UG/august-proxy/releases';

export function UpdateSection() {
  const { available, checking, error, installing, progress, formatBytes, install, refresh } =
    useAppUpdate();
  const { status: backend, sync, isTauri: backendTauri } = useBackendStatus();
  const [currentVersion, setCurrentVersion] = useState<string>('…');

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

  const ready = progress.phase === 'ready';

  return (
    <div className="px-8 py-6 max-w-2xl">
      {/* Identity header */}
      <div className="flex flex-col items-center pt-2 text-center">
        <div className="grid size-16 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
          <Sparkles className="size-7 text-primary" />
        </div>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground">August</h1>
        <p className="text-sm text-muted-foreground">Version {currentVersion}</p>
      </div>

      {/* Updates card */}
      <div className="mt-6 rounded-xl border border-white/[0.06] bg-card/60 p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RefreshCw className={checking ? 'size-4 animate-spin' : 'size-4'} />
          Updates
        </div>

        {!isTauri ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0" />
            Check for updates is only available in the desktop app.
          </div>
        ) : (
          <>
            <div className="mt-3 min-h-[1.25rem] text-sm">
              {error ? (
                <span className="flex items-center gap-2 text-red-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  Update check failed: {error.message || 'could not reach the release feed'}
                </span>
              ) : available ? (
                <span className="flex items-center gap-2 font-medium text-amber-400">
                  <Download className="size-3.5 shrink-0" />
                  A new update is ready: v{available.version}
                </span>
              ) : checking ? (
                <span className="text-muted-foreground">Checking for updates…</span>
              ) : (
                <span className="flex items-center gap-2 text-green-400">
                  <CheckCircle className="size-3.5 shrink-0" />
                  You&apos;re on the latest version
                </span>
              )}
            </div>

            {available?.date && (
              <p className="mt-1 text-xs text-muted-foreground">
                Released {new Date(available.date).toLocaleDateString()}
              </p>
            )}
            {available?.body && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-black/20 p-3">
                <pre className="whitespace-pre-wrap font-sans text-xs text-muted-foreground">
                  {available.body}
                </pre>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refresh()}
                disabled={checking || installing}
                data-testid="about-check-now"
              >
                <RefreshCw className={checking ? 'size-3.5 mr-1.5 animate-spin' : 'size-3.5 mr-1.5'} />
                Check now
              </Button>
              {available && (!installing || ready) && (
                <Button size="sm" onClick={() => { void install(); }} data-testid="about-update-now">
                  {ready
                    ? <CheckCircle className="size-3.5 mr-1.5" />
                    : <Download className="size-3.5 mr-1.5" />}
                  {ready ? 'Restart to update' : 'Update now'}
                </Button>
              )}
              {installing && !ready && (
                <span className="text-xs font-medium text-primary">
                  {progress.phase === 'restarting'
                    ? 'Installing…'
                    : progress.phase === 'installing'
                      ? 'Launching installer…'
                      : progress.percent != null
                        ? `Downloading ${progress.percent}%`
                        : 'Downloading…'}
                </span>
              )}
              <button
                type="button"
                onClick={() => { void openExternal(RELEASES_URL); }}
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
                data-testid="about-release-notes"
              >
                <ExternalLink className="size-3.5" /> Release notes
              </button>
            </div>
          </>
        )}
      </div>

      {/* Automatic updates note */}
      {isTauri && (
        <div className="mt-4">
          <p className="text-sm font-medium text-foreground">Automatic updates</p>
          <p className="mt-1 text-xs text-muted-foreground">
            August checks for updates automatically in the background and lets you know when one
            is ready.
          </p>
        </div>
      )}

      {/* Install progress */}
      {installing && (
        <div className="mt-4 rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {ready
                  ? `${available?.version ?? 'Update'} is ready`
                  : progress.phase === 'restarting'
                    ? 'Installing update…'
                    : progress.phase === 'installing'
                      ? 'Launching installer…'
                      : 'Downloading update…'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {ready
                  ? 'The update is downloaded. Restart when you’re ready to apply it.'
                  : progress.phase === 'restarting'
                    ? 'Updating now. The old version is removed automatically; you’ll see the install wizard, then the app reopens.'
                    : progress.phase === 'installing'
                      ? 'The setup window will appear in a moment.'
                      : 'The installer opens after the download finishes.'}
              </p>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
              {ready || progress.phase === 'installing' || progress.phase === 'restarting'
                ? '100%'
                : progress.percent != null
                  ? `${progress.percent}%`
                  : '…'}
            </span>
          </div>
          <UpdateProgressBar progress={progress} />
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {progress.totalBytes != null && progress.totalBytes > 0
              ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
              : progress.downloadedBytes > 0
                ? `${formatBytes(progress.downloadedBytes)} downloaded`
                : 'Starting download…'}
          </p>
        </div>
      )}

      <div className="mt-4">
        <BackendDepsCard backend={backend} onSync={() => { void sync(); }} isTauri={backendTauri} />
      </div>
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
    syncLabel = 'Backend needs first-launch setup';
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
