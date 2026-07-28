/**
 * Full-screen overlay while an update installs / the app is about to relaunch.
 * Prevents a confusing blank quit — users see a clear "restarting" moment.
 *
 * Bold & prominent by design: a strong dimmed backdrop + a large card with the
 * target version, a branded pulsing icon, and the AUG progress bar. The
 * underlying color tokens (bg-background, bg-card, bg-primary, …) are
 * registered in tailwind.config.cjs backed by `--dt-*-hsl` channels, so the
 * `/NN` alpha modifiers here actually render semi-opaque (previously they were
 * silently transparent because the tokens were only plain CSS classes).
 */

import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useAppUpdateInstallStore } from '@/store/app-update-install';
import { useAppUpdateVersion } from '@/hooks/useAppUpdate';

export function UpdateRelaunchOverlay() {
  const installing = useAppUpdateInstallStore((s) => s.installing);
  const progress = useAppUpdateInstallStore((s) => s.progress);
  const targetVersion = useAppUpdateVersion();
  const visible =
    installing &&
    (progress.phase === 'installing' || progress.phase === 'restarting');

  const restarting = progress.phase === 'restarting';

  const title = restarting
    ? targetVersion
      ? `Installing August v${targetVersion}…`
      : 'Installing August…'
    : 'Preparing installer…';

  const subtitle = restarting
    ? 'August is closing so the update can apply. The uninstall wizard pops up first, then the install wizard — August reopens once it’s done.'
    : 'The setup window will appear in a moment. You’ll see the uninstall wizard first, then the install wizard.';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-background/90 backdrop-blur-md"
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
            className="mx-6 w-full max-w-lg rounded-2xl border border-border/60 bg-card/95 p-7 shadow-2xl ring-1 ring-primary/30"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          >
            <div className="flex items-start gap-4">
              <span
                className="relative grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/40"
                aria-hidden
              >
                {/* Pulsing glow ring for liveness */}
                <span className="absolute inset-0 rounded-2xl ring-1 ring-primary/40 animate-pulse" />
                <RefreshCw
                  className={
                    restarting
                      ? 'size-6 animate-spin'
                      : 'size-6 animate-[aug-relaunch-spin_2.4s_linear_infinite]'
                  }
                />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="update-relaunch-title"
                  className="text-lg font-semibold tracking-tight text-foreground"
                >
                  {title}
                </h2>
                <p
                  id="update-relaunch-desc"
                  className="mt-1.5 text-sm text-muted-foreground leading-relaxed"
                >
                  {subtitle}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-2.5">
              <UpdateProgressBar progress={progress} />
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-1.5 rounded-full bg-primary animate-pulse"
                    aria-hidden
                  />
                  {restarting ? 'Setup wizard opening…' : 'Preparing…'}
                </span>
                <span className="tabular-nums font-medium text-foreground/80">
                  {restarting ? 'August will reopen automatically' : '100%'}
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
