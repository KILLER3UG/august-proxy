/* ── Empty chat state ──────────────────────────────────────────────────── */
/* Centered first-run copy and composer (or plan banner) before any turns. */

import { motion } from 'framer-motion';
import { workspaceBaseName } from '@/lib/utils';
import type { ReactNode } from 'react';

export function ChatEmptyState({
  workspacePath,
  children,
}: {
  workspacePath?: string | null;
  children: ReactNode;
}) {
  return (
    <motion.div
      key="centered-layout"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="flex-1 flex flex-col items-center justify-center px-6"
    >
      <div className="w-full max-w-3xl px-4 flex flex-col items-center gap-8">
        <h1 className="text-2xl font-semibold tracking-tight text-center text-foreground/90 mb-2">
          What should we build in{' '}
          <span className="text-muted-foreground font-mono">
            {workspacePath ? workspaceBaseName(workspacePath) : 'august-proxy'}
          </span>
          ?
        </h1>

        <div className="w-full max-w-lg rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-left text-xs text-muted-foreground space-y-2">
          <p className="font-semibold text-foreground/80 text-[11px] uppercase tracking-wide">
            How August works
          </p>
          <ol className="list-decimal list-inside space-y-1.5 leading-relaxed">
            <li>
              Pick a mode next to the box:{' '}
              <span className="text-foreground/80">Plan only</span>,{' '}
              <span className="text-foreground/80">Ask before changes</span>, or{' '}
              <span className="text-foreground/80">Make changes</span>.
            </li>
            <li>
              In Plan only, August proposes a plan — Accept or revise before it
              edits files.
            </li>
            <li>
              Open the right panel for{' '}
              <span className="text-foreground/80">Plan</span>,{' '}
              <span className="text-foreground/80">Tasks</span>, and{' '}
              <span className="text-foreground/80">Diffs</span>.
            </li>
            <li>
              Press{' '}
              <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">
                Ctrl+K
              </kbd>{' '}
              for undo, branch chat, free memory, and more.
            </li>
          </ol>
        </div>

        <div className="w-full">{children}</div>
      </div>
    </motion.div>
  );
}
