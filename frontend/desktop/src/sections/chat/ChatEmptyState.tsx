/* ── Empty chat state ──────────────────────────────────────────────────── */

import { motion } from 'framer-motion';
import { GitBranch, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { t } from '@/lib/motion';

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
      transition={t.smooth}
      className="august-empty-state flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden"
    >
      <div className="august-empty-state-content relative w-full max-w-3xl px-4 flex flex-col items-center gap-6">
        {harness === 'orchestrator' ? (
          <>
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 backdrop-blur px-2.5 py-1 text-2xs font-medium tracking-wide text-muted-foreground">
                <GitBranch className="size-3 opacity-60" />
                Orchestrator
              </span>
              {/* The same class the chat empty state uses: one hero size for
                  both branches (see `.august-empty-title` in chat.css). This
                  used to be `text-[1.625rem]` inline, 6px larger than the chat
                  branch's — the mode you were in changed the screen's scale. */}
              <p className="august-empty-title text-foreground">
                Plan a wave, then dispatch
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2" data-testid="orchestrator-empty-examples">
              {ORCH_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="max-w-[210px] rounded-xl border border-border/40 bg-card/40 backdrop-blur px-3.5 py-2.5 text-left hover:bg-card hover:border-border/60 transition-colors"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('august:open-spawn', { detail: { goals: ex.goals } }));
                  }}
                >
                  <span className="block text-[0.78125rem] font-medium tracking-tight text-foreground/90">{ex.label}</span>
                  <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{ex.hint}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-medium hover:bg-primary/90 transition-opacity"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('august:open-spawn'));
              }}
            >
              <Send className="size-3" />
              Dispatch
            </button>
          </>
        ) : null}

        <div className="w-full pt-1">{children}</div>

      </div>
    </motion.div>
  );
}
