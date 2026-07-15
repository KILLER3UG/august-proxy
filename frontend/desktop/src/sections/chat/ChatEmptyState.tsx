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

        <div className="w-full">{children}</div>
      </div>
    </motion.div>
  );
}
