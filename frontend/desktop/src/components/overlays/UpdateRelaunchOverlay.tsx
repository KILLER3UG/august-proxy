/** Global update flow dialog: download → ready → explicit restart.
 *
 * Styled with the same conversation chrome as the app-opening / update
 * celebration UI (ConversationStage): an "August" titlebar with a live status
 * pill, a user + assistant bubble thread, and a composer-style action row —
 * so updating looks like the app talking to you rather than a generic modal.
 */

import { useEffect, useState } from 'react';
import { CalendarDays, Download, RefreshCw, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useAppUpdate, useAppUpdateVersion } from '@/hooks/useAppUpdate';
import { useAppUpdateInstallStore } from '@/store/app-update-install';
import { cn } from '@/lib/utils';

export function UpdateRelaunchOverlay() {
  const installing = useAppUpdateInstallStore((s) => s.installing);
  const progress = useAppUpdateInstallStore((s) => s.progress);
  const { available, formatBytes, install, cancelDownload } = useAppUpdate();
  const cachedVersion = useAppUpdateVersion();
  const [readyDismissed, setReadyDismissed] = useState(false);

  const downloading = progress.phase === 'downloading';
  const ready = progress.phase === 'ready';
  const restarting = progress.phase === 'restarting';
  const installingWizard = progress.phase === 'installing';
  const visible = installing && (downloading || ready || installingWizard || restarting);
  const targetVersion = available?.version ?? cachedVersion;
  const vLabel = targetVersion ? `v${targetVersion}` : 'the update';

  useEffect(() => {
    if (!ready) setReadyDismissed(false);
  }, [ready]);

  const showDialog = visible && (!ready || !readyDismissed);

  const pill = downloading
    ? { text: 'downloading', ok: false }
    : ready
      ? { text: 'ready', ok: true }
      : { text: 'installing', ok: false };

  const userLine = downloading
    ? 'grab the latest build'
    : ready
      ? 'is it ready?'
      : 'apply it';

  const assistantLine = downloading
    ? `Downloading ${vLabel}. The latest desktop build is coming down — you can keep working while it finishes.`
    : ready
      ? `${vLabel} is downloaded and ready. Restart whenever you like to apply it.`
      : restarting
        ? `Installing ${vLabel}. The app is closing so the update can apply — the installer will reopen it shortly.`
        : 'Preparing the installer…';

  const bytesLine =
    progress.totalBytes != null
      ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
      : progress.downloadedBytes > 0
        ? `${formatBytes(progress.downloadedBytes)} downloaded`
        : 'Starting…';

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
          aria-label="App update"
        >
          <motion.div
            className="w-[min(92vw,460px)] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          >
            {/* Titlebar — matches ConversationStage */}
            <div className="flex items-center gap-2 border-b border-border/60 bg-card/40 px-4 py-2.5">
              <span
                aria-hidden
                className="grid size-5 place-items-center rounded-md border border-border bg-elevated text-[11px] font-bold text-primary"
              >
                A
              </span>
              <span className="text-[13px] font-semibold text-foreground">August</span>
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground">
                <span className={cn('size-1.5 rounded-full', pill.ok ? 'bg-success' : 'bg-primary')} />
                {pill.text}
              </span>
            </div>

            {/* Thread */}
            <div className="flex flex-col gap-3.5 px-4 py-4">
              <div className="flex justify-end" data-testid="update-user">
                <div className="max-w-[80%] rounded-2xl bg-user-bubble px-3.5 py-2 text-[13.5px] leading-snug text-foreground">
                  {userLine}
                </div>
              </div>
              <div className="flex items-start gap-2.5" data-testid="update-assistant">
                <span
                  aria-hidden
                  className="mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-border bg-elevated text-[10px] font-bold text-primary"
                >
                  A
                </span>
                <div className="min-w-0 flex-1 pt-0.5 text-[13.5px] leading-relaxed text-foreground/90">
                  {assistantLine}
                  {available?.date && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground/80">
                      <CalendarDays className="size-3.5" aria-hidden />
                      {new Date(available.date).toLocaleDateString()}
                    </p>
                  )}
                  {downloading && (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium text-foreground">Download progress</span>
                        <span className="tabular-nums text-muted-foreground">{bytesLine}</span>
                      </div>
                      <UpdateProgressBar
                        progress={progress}
                        showLabel={false}
                        className="h-2 rounded-full border-0 bg-muted"
                      />
                      <span className="text-xs text-muted-foreground">
                        {progress.percent != null ? `${progress.percent}%` : 'Downloading…'}
                      </span>
                    </div>
                  )}
                  {(installingWizard || restarting) && (
                    <div className="mt-3 space-y-2">
                      <UpdateProgressBar
                        progress={progress}
                        showLabel={false}
                        className="h-2 rounded-full border-0 bg-muted"
                      />
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Download className="size-3.5" /> Setup wizard opening…
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Composer-style action row */}
            <div className="flex items-center gap-2 px-3 pb-3">
              <div className="flex-1 truncate rounded-xl border border-border bg-card/50 px-3 py-2 text-[12.5px] text-muted-foreground/70">
                {downloading
                  ? 'Downloading in the background…'
                  : ready
                    ? 'Ready to restart'
                    : 'Applying the update…'}
              </div>
              {downloading && (
                <button
                  type="button"
                  onClick={cancelDownload}
                  className="update-flow-secondary-button shrink-0 rounded-lg px-3 py-2 text-sm"
                  data-testid="update-cancel"
                >
                  Cancel
                </button>
              )}
              {ready && (
                <>
                  <button
                    type="button"
                    onClick={() => setReadyDismissed(true)}
                    className="shrink-0 rounded-lg px-2.5 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label="Later"
                    title="Later"
                    data-testid="update-later"
                  >
                    <X className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { void install(); }}
                    className="update-flow-primary-button inline-flex shrink-0 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium"
                    data-testid="update-restart"
                  >
                    <RefreshCw className="size-3.5" />
                    Restart to update
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
