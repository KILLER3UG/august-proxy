/* ── UpdateProgressBar — branded download/install progress ──────────── */
/* Shared by Updates settings + Notifications so install animation matches. */

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { AppUpdateProgress } from '@/store/app-update-install';

export function UpdateProgressBar({
  progress,
  className,
}: {
  progress: AppUpdateProgress;
  className?: string;
}) {
  const indeterminate =
    progress.phase === 'downloading' && progress.percent == null;
  const restarting = progress.phase === 'restarting';
  const fill =
    progress.phase === 'installing' || restarting
      ? 100
      : progress.percent != null
        ? Math.min(100, Math.max(0, progress.percent))
        : indeterminate
          ? 32
          : 0;

  return (
    <div
      className={cn(
        'relative h-7 w-full overflow-hidden rounded-lg border border-border/50 bg-muted/70',
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : fill}
      aria-label={
        restarting
          ? 'Update restarting'
          : progress.phase === 'installing'
            ? 'Update installing'
            : 'Update download progress'
      }
      data-phase={progress.phase}
    >
      <motion.div
        className={cn(
          'absolute inset-y-0 left-0 overflow-hidden rounded-[7px] bg-primary',
          restarting && 'animate-[aug-relaunch-pulse_1.6s_ease-in-out_infinite]',
        )}
        initial={false}
        animate={{ width: `${fill}%` }}
        transition={{ type: 'spring', stiffness: 140, damping: 26, mass: 0.55 }}
      >
        <div
          className={cn(
            'absolute inset-0 opacity-90',
            'bg-[linear-gradient(110deg,transparent_25%,rgba(255,255,255,0.45)_50%,transparent_75%)]',
            'bg-[length:220%_100%] animate-[aug-progress-shine_1.35s_ease-in-out_infinite]',
          )}
        />
      </motion.div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="select-none text-[11px] font-bold tracking-[0.28em] text-foreground/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)]">
          {restarting ? '…' : 'AUG'}
        </span>
      </div>
    </div>
  );
}
