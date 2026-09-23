/* ── Empty chat state ──────────────────────────────────────────────────── */

import { motion } from 'framer-motion';
import { GitBranch, Send, Clock, Bug, FileText, Code2 } from 'lucide-react';
import { workspaceBaseName } from '@/lib/utils';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { dispatchInsertComposerText, dispatchFocusComposer } from '@/api/ui-events';

const PROMPT_SUGGESTIONS = [
  {
    icon: Code2,
    title: 'Explain codebase architecture',
    hint: 'Map key components & dependencies',
    prompt: 'Can you give an overview of this codebase architecture and key dependencies?',
  },
  {
    icon: Bug,
    title: 'Scan for bugs & run tests',
    hint: 'Find issues & verify test suites',
    prompt: 'Check the workspace for potential bugs and run the project test suite.',
  },
  {
    icon: GitBranch,
    title: 'Review git changes',
    hint: 'Inspect uncommitted modifications',
    prompt: 'Review the current git status and uncommitted changes in this repository.',
  },
  {
    icon: FileText,
    title: 'Draft documentation',
    hint: 'Create README or API guides',
    prompt: 'Help me draft updated documentation for the key features in this project.',
  },
];

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
      className="august-empty-state flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden"
    >
      {/* DeepSeek-inspired soft glow: one blurred ellipse centered behind the hero, not a card */}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 w-[820px] h-[360px] opacity-[0.55] dark:opacity-[0.45]"
        viewBox="0 0 1051 468"
        fill="none"
      >
        <defs>
          <filter id="august-hero-glow" x="0" y="0" width="1051" height="468" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
            <feGaussianBlur stdDeviation="48" result="glow" />
          </filter>
        </defs>
        <g filter="url(#august-hero-glow)">
          <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.07" />
        </g>
      </svg>

      <div className="august-empty-state-content relative w-full max-w-3xl px-4 flex flex-col items-center gap-6">
        {harness === 'orchestrator' ? (
          <>
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 backdrop-blur px-2.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                <GitBranch className="size-3 opacity-60" />
                Orchestrator
              </span>
              <h1 className="text-[26px] font-[650] tracking-[-0.03em] leading-tight text-foreground">
                Plan a wave, then dispatch
              </h1>
              <p className="max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
                in <span className="font-mono text-foreground/70">{project}</span> — you stay here, workers edit and run.
              </p>
            </div>
            <ol className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70">
              <li className="rounded-full bg-muted/40 px-2.5 py-1 border border-border/30">Plan</li>
              <li className="opacity-30">→</li>
              <li className="rounded-full bg-muted/40 px-2.5 py-1 border border-border/30">Dispatch</li>
              <li className="opacity-30">→</li>
              <li className="rounded-full bg-muted/40 px-2.5 py-1 border border-border/30">Review</li>
            </ol>
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
                  <span className="block text-[12.5px] font-medium tracking-tight text-foreground/90">{ex.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{ex.hint}</span>
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
        ) : (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[30px] font-[620] tracking-[-0.03em] leading-tight text-foreground">
                What should we work on?
              </h1>
              <p className="text-[13px] text-muted-foreground/60">
                in <span className="font-mono text-foreground/55">{project}</span> — pick a starter or type a prompt.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-xl my-1" data-testid="empty-state-suggestions">
              {PROMPT_SUGGESTIONS.map((card) => {
                const CardIcon = card.icon;
                return (
                  <button
                    key={card.title}
                    type="button"
                    onClick={() => {
                      dispatchInsertComposerText(card.prompt);
                      dispatchFocusComposer();
                    }}
                    className="flex items-start gap-3 rounded-xl border border-border/40 bg-card/40 backdrop-blur-sm p-3 text-left hover:bg-card hover:border-border/70 transition-all cursor-pointer group shadow-2xs"
                  >
                    <span className="mt-0.5 rounded-lg p-1.5 bg-muted/40 text-muted-foreground group-hover:text-primary transition-colors shrink-0">
                      <CardIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-foreground/90 group-hover:text-foreground">
                        {card.title}
                      </div>
                      <div className="text-[11.5px] text-muted-foreground/70 leading-snug truncate">
                        {card.hint}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="w-full pt-1">{children}</div>

      </div>
    </motion.div>
  );
}
