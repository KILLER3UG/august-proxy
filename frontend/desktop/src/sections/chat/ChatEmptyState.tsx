/* ── Empty chat state ──────────────────────────────────────────────────── */

import { motion } from 'framer-motion';
import { workspaceBaseName } from '@/lib/utils';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';

const ORCH_EXAMPLES = [
  {
    label: 'Explore → implement → review',
    goals: 'explore: map the relevant files\nimplement after:explore: make the change\nreview after:implement: verify with tests',
  },
  {
    label: 'Investigate a bug',
    goals: 'repro: find a failing test or steps\nfix after:repro: patch the cause\nverify after:fix: confirm the repro is gone',
  },
  {
    label: 'Read-only survey',
    goals: 'explore: summarize architecture and risks',
  },
];

export function ChatEmptyState({
  workspacePath,
  children,
  agentMode,
}: {
  workspacePath?: string | null;
  children: ReactNode;
  agentMode?: string | null;
}) {
  const harness = normalizeHarnessMode(agentMode);
  return (
    <motion.div
      key="centered-layout"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="august-empty-state flex-1 flex flex-col items-center justify-center px-6"
    >
      <div className="august-empty-state-content w-full max-w-3xl px-4 flex flex-col items-center gap-8">
        <h1 className="text-2xl font-semibold tracking-tight text-center text-foreground/90 mb-2">
          {harness === 'orchestrator' ? (
            <>
              Dispatch work in{' '}
              <span className="text-muted-foreground font-mono">
                {workspacePath ? workspaceBaseName(workspacePath) : 'your project'}
              </span>
            </>
          ) : (
            <>
              What should we build in{' '}
              <span className="text-muted-foreground font-mono">
                {workspacePath ? workspaceBaseName(workspacePath) : 'your project'}
              </span>
              ?
            </>
          )}
        </h1>

        {harness === 'orchestrator' ? (
          <div className="flex flex-wrap justify-center gap-2" data-testid="orchestrator-empty-examples">
            {ORCH_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('august:open-spawn', { detail: { goals: ex.goals } }));
                }}
              >
                {ex.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="w-full">{children}</div>
      </div>
    </motion.div>
  );
}
