/* ── Empty chat state ──────────────────────────────────────────────────── */

import { motion } from 'framer-motion';
import { GitBranch, Send, Clock, Bug, FileText } from 'lucide-react';
import { workspaceBaseName } from '@/lib/utils';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { dispatchInsertComposerText, dispatchFocusComposer } from '@/api/ui-events';

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

const NORMAL_STARTERS = [
  {
    label: 'Standup Git Summary',
    hint: 'Summarize commits, PRs, and blockers from the week across aug…',
    prompt: 'Summarize the standup: git log, open PRs, and recent CI failures for this week.',
    Icon: Clock,
  },
  {
    label: 'CI Failures & Flaky Tests',
    hint: 'Root-cause the last CI run, surface flaky tests and likely fixes.',
    prompt: 'Analyze the last CI failure log, find the root cause, and propose a minimal fix with a sample patch.',
    Icon: Bug,
  },
  {
    label: 'Create PowerPoint',
    hint: 'Draft a high-tech deck: The Evolution of AI Agents (5 slides).',
    prompt: 'Please help me create a high-tech PowerPoint presentation on the topic "The Evolution of AI Agents" (5 slides).',
    Icon: FileText,
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
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-4 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('august:open-spawn'));
              }}
            >
              <Send className="size-3" />
              Dispatch
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-[30px] font-[620] tracking-[-0.03em] leading-tight text-foreground">
              What should we work on?
            </h1>
            <p className="text-[13px] text-muted-foreground/60">in <span className="font-mono text-foreground/55">{project}</span> — pick a project below or just ask.</p>
          </div>
        )}

        <div className="w-full pt-1">{children}</div>

        {/* Reference-inspired starter templates — only on blank normal mode, like Z.ai “Standup / CI / PowerPoint” */}
        {harness !== 'orchestrator' && (
          <div className="grid w-full grid-cols-3 gap-3 pt-2" data-testid="empty-starter-templates">
            {NORMAL_STARTERS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => {
                  dispatchInsertComposerText(s.prompt);
                  dispatchFocusComposer();
                }}
                className="text-left rounded-xl border border-border/40 bg-card/40 backdrop-blur px-3.5 py-3 hover:bg-card/60 hover:border-border/60 transition text-foreground/90"
              >
                <div className="flex items-center gap-1.5 text-[12px] font-medium">
                  <s.Icon className="size-3.5 text-muted-foreground/70" />
                  {s.label}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{s.hint}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
