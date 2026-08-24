/** Global update flow dialog: download → ready → explicit restart. */

import { useEffect, useState } from 'react';
import { CalendarDays, Download, RefreshCw, Sparkles, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useAppUpdate, useAppUpdateVersion } from '@/hooks/useAppUpdate';
import { useAppUpdateInstallStore } from '@/store/app-update-install';

export function UpdateRelaunchOverlay() {
  const installing = useAppUpdateInstallStore((s) => s.installing);
  const progress = useAppUpdateInstallStore((s) => s.progress);
  const { available, formatBytes, install, cancelDownload } = useAppUpdate();
  const cachedVersion = useAppUpdateVersion();
  const [readyDismissed, setReadyDismissed] = useState(false);

  const downloading = progress.phase === 'downloading';
  const ready = progress.phase === 'ready';
  const restarting = progress.phase === 'restarting';
  const visible = installing && (downloading || ready || progress.phase === 'installing' || restarting);
  const targetVersion = available?.version ?? cachedVersion;

  useEffect(() => {
    if (!ready) setReadyDismissed(false);
  }, [ready]);

  const showDialog = visible && (!ready || !readyDismissed);
  const title = downloading
    ? `Downloading${targetVersion ? ` v${targetVersion}` : ''}`
    : ready
      ? `${targetVersion ? `v${targetVersion}` : 'Update'} is ready`
      : restarting
        ? targetVersion
          ? `Installing v${targetVersion}…`
          : 'Installing update…'
        : 'Preparing installer…';

  const subtitle = downloading
    ? 'The latest desktop build is downloading. You can keep working while this finishes.'
    : ready
      ? 'The update is downloaded and ready. Restart when you’re ready to apply it.'
      : restarting
        ? 'The app is closing so the update can apply. The installer will guide you through the final step, then it reopens.'
        : 'The setup window will appear in a moment.';

  return (
    <AnimatePresence>
      {showDialog && (
        <motion.div
          className="update-flow-backdrop fixed inset-0 z-[200] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="update-flow-title"
          aria-describedby="update-flow-description"
        >
          <motion.div
            className="update-flow-card w-full max-w-[640px] rounded-2xl border p-6 shadow-2xl"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          >
            <div className="flex items-start gap-4">
              <span className="update-flow-icon relative grid size-14 shrink-0 place-items-center rounded-2xl" aria-hidden>
                <Sparkles className="size-6" />
                {(downloading || restarting) && <span className="absolute inset-0 rounded-2xl ring-1 ring-primary/50 animate-pulse" />}
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="update-flow-title" className="text-xl font-semibold tracking-tight text-foreground">
                  {title}
                </h2>
                <p id="update-flow-description" className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {subtitle}
                </p>
                {available?.date && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground/80">
                    <CalendarDays className="size-3.5" aria-hidden />
                    {new Date(available.date).toLocaleDateString()}
                  </p>
                )}
              </div>
              {ready && (
                <button
                  type="button"
                  onClick={() => setReadyDismissed(true)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                  aria-label="Later"
                  title="Later"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            {downloading && (
              <div className="mt-7 space-y-2.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">Download progress</span>
                  <span className="tabular-nums text-muted-foreground">
                    {progress.totalBytes != null
                      ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
                      : progress.downloadedBytes > 0
                        ? `${formatBytes(progress.downloadedBytes)} downloaded`
                        : 'Starting…'}
                  </span>
                </div>
                <UpdateProgressBar progress={progress} showLabel={false} className="h-2 rounded-full border-0 bg-muted" />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {progress.percent != null ? `${progress.percent}%` : 'Downloading…'}
                  </span>
                  <button type="button" onClick={cancelDownload} className="update-flow-secondary-button rounded-lg px-3 py-2 text-sm">
                    Cancel download
                  </button>
                </div>
              </div>
            )}

            {ready && (
              <div className="mt-7 flex items-center justify-end gap-2">
                <button type="button" onClick={() => setReadyDismissed(true)} className="update-flow-secondary-button rounded-lg px-4 py-2.5 text-sm">
                  Later
                </button>
                <button type="button" onClick={() => { void install(); }} className="update-flow-primary-button inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium">
                  <RefreshCw className="size-3.5" />
                  Restart to update
                </button>
              </div>
            )}

            {(progress.phase === 'installing' || restarting) && (
              <div className="mt-6 space-y-2.5">
                <UpdateProgressBar progress={progress} showLabel={false} className="h-2 rounded-full border-0 bg-muted" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><Download className="size-3.5" /> Setup wizard opening…</span>
                  <span>100%</span>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
