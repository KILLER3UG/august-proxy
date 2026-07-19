/**
 * Full-screen overlay while an update installs / the app is about to relaunch.
 * Prevents a confusing blank quit — users see a clear “restarting” moment.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useAppUpdateInstallStore } from '@/store/app-update-install';

export function UpdateRelaunchOverlay() {
  const installing = useAppUpdateInstallStore((s) => s.installing);
  const progress = useAppUpdateInstallStore((s) => s.progress);
  const visible =
    installing &&
    (progress.phase === 'installing' || progress.phase === 'restarting');

  const restarting = progress.phase === 'restarting';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-background/85 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="update-relaunch-title"
          aria-describedby="update-relaunch-desc"
        >
          <motion.div
            className="mx-6 w-full max-w-md rounded-2xl border border-border/60 bg-card/95 p-6 shadow-2xl"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          >
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 grid size-10 place-items-center rounded-xl bg-primary/15 text-primary"
                aria-hidden
              >
                <RefreshCw
                  className={
                    restarting
                      ? 'size-5 animate-spin'
                      : 'size-5 animate-[aug-relaunch-spin_2.4s_linear_infinite]'
                  }
                />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="update-relaunch-title"
                  className="text-base font-semibold tracking-tight text-foreground"
                >
                  {restarting ? 'Restarting August…' : 'Installing update…'}
                </h2>
                <p
                  id="update-relaunch-desc"
                  className="mt-1 text-sm text-muted-foreground leading-relaxed"
                >
                  {restarting
                    ? 'The app will close briefly and reopen on the new version. This can take a moment — please wait.'
                    : 'Finishing the install. August will restart automatically when ready.'}
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <UpdateProgressBar progress={progress} />
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full bg-primary animate-pulse"
                    aria-hidden
                  />
                  {restarting ? 'Relaunching…' : 'Preparing restart…'}
                </span>
                <span className="tabular-nums font-medium text-foreground/80">
                  {restarting ? 'Almost there' : '100%'}
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
