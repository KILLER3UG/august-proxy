/* ── Empty chat state ──────────────────────────────────────────────────── */

import { motion } from 'framer-motion';
import { GitBranch, Send } from 'lucide-react';
import { workspaceBaseName } from '@/lib/utils';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';

const ORCH_EXAMPLES = [
  {
    label: 'Explore → implement → review',
    hint: 'Three waves, each waits on the last',
    goals: 'explore: map the relevant files\nimplement after:explore: make the change\nreview after:implement: verify with tests',
  },
  {
    label: 'Investigate a bug',
    hint: 'Repro, patch, confirm',
    goals: 'repro: find a failing test or steps\nfix after:repro: patch the cause\nverify after:fix: confirm the repro is gone',
  },
  {
    label: 'Read-only survey',
    hint: 'Workers read; nothing writes',
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
  const project = workspacePath ? workspaceBaseName(workspacePath) : 'your project';
  return (
    <motion.div
      key="centered-layout"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="august-empty-state flex-1 flex flex-col items-center justify-center px-6"
    >
      <div className="august-empty-state-content w-full max-w-3xl px-4 flex flex-col items-center gap-7">
        {harness === 'orchestrator' ? (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] text-violet-200">
                <GitBranch className="size-3" />
                Orchestrator
              </span>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground/90">
                Plan a wave, then dispatch in{' '}
                <span className="font-mono text-muted-foreground">{project}</span>
              </h1>
              <p className="max-w-md text-[13px] text-muted-foreground">
                You stay in this chat. Workers edit and run. Open Dispatch from + or use a starter below.
              </p>
            </div>
            <ol className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-muted-foreground">
              <li className="rounded-full border border-border/50 bg-muted/20 px-2.5 py-1">1 Plan</li>
              <li className="text-muted-foreground/40">→</li>
              <li className="rounded-full border border-border/50 bg-muted/20 px-2.5 py-1">2 Dispatch</li>
              <li className="text-muted-foreground/40">→</li>
              <li className="rounded-full border border-border/50 bg-muted/20 px-2.5 py-1">3 Review here</li>
            </ol>
            <div className="flex flex-wrap justify-center gap-2" data-testid="orchestrator-empty-examples">
              {ORCH_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="max-w-[220px] rounded-xl border border-border/60 bg-muted/10 px-3 py-2 text-left hover:border-primary/40"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('august:open-spawn', { detail: { goals: ex.goals } }));
                  }}
                >
                  <span className="block text-[12.5px] text-foreground/90">{ex.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{ex.hint}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('august:open-spawn'));
              }}
            >
              <Send className="size-3" />
              Dispatch
            </button>
          </>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight text-center text-foreground/90 mb-2">
            What should we build in{' '}
            <span className="text-muted-foreground font-mono">{project}</span>?
          </h1>
        )}

        <div className="w-full">{children}</div>
      </div>
    </motion.div>
  );
}
