/* ── Empty chat state — the launchpad ─────────────────────────────────── */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { loadMessagesForSession } from '@/sections/chat/chat-stream-manager';
import { useSessionsStore } from '@/store/sessions';
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

  return (
    <motion.div
      key="launchpad"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, y: 20 }}
      transition={t.smooth}
      className="august-empty-state launchpad flex-1 min-h-0 overflow-y-auto"
    >
      <div className="launchpad-inner">
        <div className="launch-eyebrow">New thread</div>
        <h1 className="launch-title">
          What are we
          <br />
          building today?
        </h1>
        <p className="launch-sub">
          Start with a goal, a file, or a dataset. August can read the workspace, run the work,
          and leave the output in a canvas.
        </p>

        {recent.length > 0 && (
          <div className="recent-strip">
            <div className="recent-head">Recent outputs</div>
            <div className="recent-row">
              {recent.map(({ sessionId, artifact }) => (
                <button
                  key={`${sessionId}:${artifact.id}`}
                  type="button"
                  className="recent-item"
                  onClick={() => {
                    void navigate(`/c/${sessionId}`);
                    openRightDrawer('artifacts');
                  }}
                >
                  <SignalIcon name={artifact.kind === 'image' ? 'image' : 'file'} />
                  {artifact.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="launch-composer">{children}</div>
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
