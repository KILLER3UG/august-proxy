/* ── Empty chat state — the launchpad ─────────────────────────────────── */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, FileText, GitBranch, LineChart, Palette, Send, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { Button } from '@/components/ui/button';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { loadMessagesForSession } from '@/sections/chat/chat-stream-manager';
import { useSessionsStore } from '@/store/sessions';
import { dispatchInsertComposerText } from '@/api/ui-events';
import { openRightDrawer } from '@/components/shell/RightDrawerState';
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

const LAUNCH_ACTIONS = [
  {
    label: 'Build something',
    hint: 'Turn a rough idea into a working surface.',
    seed: 'Help me build ',
    Icon: Wrench,
  },
  {
    label: 'Analyze a dataset',
    hint: 'Find the shape, the outliers, and the story.',
    seed: 'Analyze this dataset. I will attach the file next.',
    Icon: LineChart,
  },
  {
    label: 'Make a visual',
    hint: 'Charts, diagrams, and artifacts worth opening.',
    seed: 'Create a visual that explains ',
    Icon: Palette,
  },
] as const;

interface RecentOutput {
  sessionId: string;
  sessionTitle: string;
  artifact: SessionArtifact;
}

/** The launchpad's recent outputs come from the same artifact derivation the
 *  Artifacts page and the drawer use, over the newest few chats. Four chats
 *  is enough to fill three rows; reading every transcript on the empty state
 *  would make opening a new chat proportional to the whole history. */
function useRecentOutputs(): RecentOutput[] {
  const sessions = useSessionsStore((state) => state.sessions);
  return useMemo(() => {
    const rows: RecentOutput[] = [];
    const newest = [...sessions]
      .filter((s) => !s.isArchived)
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt))
      .slice(0, 4);
    for (const session of newest) {
      let messages;
      try {
        messages = loadMessagesForSession(session.id);
      } catch {
        continue;
      }
      const produced = collectArtifacts(messages).filter((a) => a.origin === 'produced');
      for (const artifact of produced.slice(0, 2)) {
        rows.push({ sessionId: session.id, sessionTitle: session.title || 'Untitled chat', artifact });
      }
      if (rows.length >= 3) break;
    }
    return rows.slice(0, 3);
  }, [sessions]);
}

function Launchpad({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const recent = useRecentOutputs();

  const seed = (text: string) => {
    dispatchInsertComposerText(text, { replace: true });
  };

  return (
    <motion.div
      key="launchpad"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 20 }}
      transition={t.smooth}
      className="august-empty-state flex-1 min-h-0 overflow-y-auto px-6"
    >
      <div className="august-launchpad mx-auto flex min-h-full w-full max-w-[860px] flex-col justify-center py-10">
        <div className="text-center">
          <div className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-foreground/45">
            New thread
          </div>
          <h1 className="font-editorial mt-3 text-[clamp(2.35rem,4.5vw,3.4rem)] font-medium leading-[1.03] tracking-[-0.045em] text-foreground">
            What are we
            <br />
            building today?
          </h1>
          <p className="mx-auto mt-4 max-w-[34rem] text-[0.8125rem] leading-relaxed text-muted-foreground/65">
            Start with a goal, a file, or a dataset. August can read the workspace, run the work,
            and leave the output in a canvas.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {LAUNCH_ACTIONS.map(({ label, hint, seed: prompt, Icon }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => seed(prompt)}
              className="group h-auto w-full flex-col items-start justify-start gap-0 rounded-xl border border-border/55 bg-card/35 px-3.5 py-3 text-left font-normal whitespace-normal transition-colors hover:border-border hover:bg-card/70"
            >
              <span className="flex items-center gap-2 text-[0.78125rem] font-medium text-foreground/90">
                <Icon className="size-3.5 text-muted-foreground/70 group-hover:text-foreground" />
                {label}
              </span>
              <span className="mt-1 block text-[0.6875rem] leading-snug text-muted-foreground/55">
                {hint}
              </span>
            </Button>
          ))}
        </div>

        {recent.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center gap-3 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground/45">
              Recent outputs
              <span className="h-px flex-1 bg-border/50" />
            </div>
            <div className="mt-2 divide-y divide-border/35 border-y border-border/35">
              {recent.map(({ sessionId, sessionTitle, artifact }) => (
                <Button
                  key={`${sessionId}:${artifact.id}`}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void navigate(`/c/${sessionId}`);
                    openRightDrawer('artifacts');
                  }}
                  className="h-auto w-full items-center justify-start gap-3 rounded-none px-1 py-2.5 text-left font-normal"
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground/55" />
                  <span className="min-w-0 flex-1 truncate text-[0.78125rem] text-foreground/85">
                    {artifact.label}
                  </span>
                  <span className="hidden sm:block shrink-0 font-mono text-[0.625rem] text-muted-foreground/40">
                    {sessionTitle}
                  </span>
                  <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/35" />
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 w-full">{children}</div>
      </div>
    </motion.div>
  );
}

export function ChatEmptyState({
  children,
  agentMode,
}: {
  workspacePath?: string | null;
  children: ReactNode;
  agentMode?: string | null;
}) {
  const harness = normalizeHarnessMode(agentMode);

  if (harness !== 'orchestrator') {
    return <Launchpad>{children}</Launchpad>;
  }

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
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 backdrop-blur px-2.5 py-1 text-2xs font-medium tracking-wide text-muted-foreground">
            <GitBranch className="size-3 opacity-60" />
            Orchestrator
          </span>
          <p className="august-empty-title text-foreground">Plan a wave, then dispatch</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2" data-testid="orchestrator-empty-examples">
          {ORCH_EXAMPLES.map((ex) => (
            <Button
              key={ex.label}
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto max-w-[210px] flex-col items-start justify-start gap-0 rounded-xl border border-border/40 bg-card/40 px-3.5 py-2.5 text-left font-normal whitespace-normal backdrop-blur hover:border-border/60 hover:bg-card"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('august:open-spawn', { detail: { goals: ex.goals } }));
              }}
            >
              <span className="block text-[0.78125rem] font-medium tracking-tight text-foreground/90">{ex.label}</span>
              <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{ex.hint}</span>
            </Button>
          ))}
        </div>
        <Button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('august:open-spawn'));
          }}
        >
          <Send className="size-3" />
          Dispatch
        </Button>

        <div className="w-full pt-1">{children}</div>
      </div>
    </motion.div>
  );
}
