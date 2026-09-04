/* ── DebateView — round controls + turn orchestrator for the active debate ── */

import { useEffect, useRef, useState } from 'react';
import { Gavel, Pause, Play, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkbenchSession } from '@/types/workbench';
import {
  useDebateStore,
  clearDebateRun,
  registerDebateTurnDone,
  nextDebater,
  debateRoundMessage,
  debateJudgeMessage,
  type DebateRun,
  type DebateLane,
} from './debate-store';
import { startChatStream } from '../chat-stream-manager';
import { getOrInitSessionStreamState } from '../stream/session-stream-store';
import { api } from '@/api/client';
import type { ChatMessage } from '@/types/chat';

function laneUserMessage(run: DebateRun, text: string): ChatMessage {
  return {
    id: `m${Date.now()}_d${run.round}`,
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Dispatch one debate turn on the session with the given lane's model
 * override. The turn's `done` SSE event fires while this await is still
 * pending, so round/awaitingTurn/judgeSent are marked SYNCHRONOUSLY before
 * the stream starts — the old post-await marking let the done handler
 * re-enter with stale state (Part 26 7.1: the opening prompt re-sent to the
 * same model and the judge summary double-dispatched).
 */
async function dispatchDebateTurn(
  run: DebateRun,
  text: string,
  ensureWorkbenchSession: () => Promise<WorkbenchSession | null>,
  lane: DebateLane,
  opts: { judge?: boolean } = {},
): Promise<void> {
  const pre = useDebateStore.getState().run;
  if (pre && pre.runId === run.runId) {
    useDebateStore.setState({
      run: {
        ...pre,
        round: opts.judge ? pre.round : pre.round + 1,
        awaitingTurn: true,
        judgeSent: opts.judge ? true : pre.judgeSent,
      },
    });
  }
  const msgs = getOrInitSessionStreamState(run.sessionId).messages ?? [];
  const userMsg = laneUserMessage(run, text);
  const chatHistory = [...msgs, userMsg];

  const result = await startChatStream(run.sessionId, {
    message: text,
    chatHistory,
    workbenchMode: 'full',
    effort: 'medium',
    model: lane.modelId,
    modelProvider: lane.provider,
    provider: lane.provider,
    ensureWorkbenchSession,
  });
  // The debate may have been closed while the turn ran — never resurrect a
  // run object by spreading a null (the old `{...run!}` crash, Part 26 7.1).
  const after = useDebateStore.getState().run;
  if (!after) return;
  if (result === 'error') {
    useDebateStore.setState({
      run: { ...after, phase: 'done', awaitingTurn: false },
    });
  }
}

export function DebateView({
  ensureWorkbenchSession,
}: {
  ensureWorkbenchSession: () => Promise<WorkbenchSession | null>;
}) {
  const run = useDebateStore((s) => s.run);
  const ensureRef = useRef(ensureWorkbenchSession);
  ensureRef.current = ensureWorkbenchSession;

  // Verdict recording: one click per finished debate → routing evidence.
  // The arena archive + reliability dashboard consume these rows, so
  // judged debates feed the same loop as arena comparisons.
  const [postingWinner, setPostingWinner] = useState<string | null>(null);
  const [winnerRecorded, setWinnerRecorded] = useState(false);

  const recordWinner = async (lane: DebateLane) => {
    if (!run || winnerRecorded) return;
    const losers = run.models
      .filter((m) => m.modelId !== lane.modelId)
      .map((m) => ({ modelId: m.modelId, provider: m.provider }));
    setPostingWinner(lane.modelId);
    try {
      await api.post('/api/brain/routing/arena', {
        sessionId: run.sessionId,
        prompt: run.prompt,
        winner: { modelId: lane.modelId, provider: lane.provider },
        losers,
      });
      setWinnerRecorded(true);
      toast.success('Verdict recorded to routing evidence');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record verdict');
    } finally {
      setPostingWinner(null);
    }
  };

  // Orchestrator: advance when a turn we initiated finishes.
  useEffect(() => {
    if (!run || run.phase !== 'running') return;
    return registerDebateTurnDone(run.sessionId, () => {
      void (async () => {
        const current = useDebateStore.getState().run;
        if (!current || current.phase !== 'running') return;
        // Consume the in-flight flag FIRST — a duplicate done event for the
        // same turn must not advance twice (Part 26 7.1 re-entry guard).
        useDebateStore.setState({
          run: { ...current, awaitingTurn: false },
        });

        const judged = current.round >= current.maxRounds && !!current.judge;
        if (judged && !current.judgeSent) {
          // Judge summary turn — dispatched on the JUDGE's lane (the old
          // code picked the lane via nextDebater, so a debater answered).
          await dispatchDebateTurn(
            current,
            debateJudgeMessage(current),
            ensureRef.current,
            current.judge!,
            { judge: true },
          );
          return;
        }
        if (judged || current.round >= current.maxRounds) {
          // Finished (judge turn already sent, or rounds exhausted)
          useDebateStore.setState({
            run: { ...useDebateStore.getState().run ?? current, phase: 'done', awaitingTurn: false },
          });
          return;
        }
        if (!current.auto) {
          // Manual pause — wait for the user to press "Next round".
          useDebateStore.setState({
            run: { ...useDebateStore.getState().run ?? current, phase: 'done', awaitingTurn: false },
          });
          return;
        }
        // Round counter increments synchronously inside dispatchDebateTurn;
        // the message + lane are computed from the pre-increment state.
        await dispatchDebateTurn(
          current,
          debateRoundMessage(current, current.round),
          ensureRef.current,
          nextDebater(current),
        );
      })();
    });
  }, [run?.runId, run?.phase]);

  if (!run) return null;

  const isRunning = run.phase === 'running';
  const debater = isRunning ? nextDebater(run) : null;
  const finished =
    !isRunning && run.round >= run.maxRounds && (run.judge ? !!run.judgeSent : true);

  const start = () => {
    const fresh: DebateRun = {
      ...run,
      phase: 'running',
      round: 0,
      judgeSent: false,
      auto: true,
      awaitingTurn: true,
    };
    useDebateStore.setState({ run: fresh });
    // Round 0's message is the opening prompt; the lane is the first debater
    // (computed from the pre-dispatch round — dispatch increments it).
    void dispatchDebateTurn(fresh, debateRoundMessage(fresh, 0), ensureRef.current, nextDebater(fresh));
  };

  const nextRound = () => {
    if (isRunning) return;
    const current = useDebateStore.getState().run;
    if (!current) return;
    useDebateStore.setState({
      run: { ...current, phase: 'running', awaitingTurn: true },
    });
    void dispatchDebateTurn(
      current,
      debateRoundMessage(current, current.round),
      ensureRef.current,
      nextDebater(current),
    );
  };

  const toggleAuto = () => {
    useDebateStore.setState({ run: { ...run, auto: !run.auto } });
  };

  const stop = () => {
    useDebateStore.setState({
      run: { ...run, phase: 'done', awaitingTurn: false, auto: false },
    });
    void import('../chat-stream-manager').then((m) => m.stopChatStream(run.sessionId));
  };

  return (
    <div
      className="fixed bottom-24 left-1/2 z-40 w-full max-w-xl -translate-x-1/2 px-4"
      data-testid="debate-view"
    >
      <div className="rounded-xl border border-border bg-popover/95 shadow-xl backdrop-blur p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Gavel className="size-4 text-primary" />
          <h3 className="text-xs font-semibold">Debate</h3>
          <p className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">
            {run.models.map((m) => m.modelName).join(' vs ')}
            {run.judge ? ` · judged by ${run.judge.modelName}` : ''}
          </p>
          <span className="text-[10px] text-muted-foreground/70 shrink-0">
            round {Math.min(run.round, run.maxRounds)}/{run.maxRounds}
            {run.judge ? ' + judge' : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              if (isRunning) stop();
              clearDebateRun();
            }}
            className="p-1 rounded text-muted-foreground hover:text-foreground shrink-0"
            title={isRunning ? 'Stop debate and close' : 'Close debate'}
            aria-label="Close debate"
            data-testid="debate-exit"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {run.phase === 'config' ? (
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground"
              data-testid="debate-start"
            >
              <Play className="size-3" />
              Start debate
            </button>
          ) : isRunning ? (
            <>
              <button
                type="button"
                onClick={stop}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-danger"
                data-testid="debate-stop"
              >
                <Square className="size-3" />
                Stop
              </button>
              <button
                type="button"
                onClick={toggleAuto}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-[11px] text-muted-foreground"
                data-testid="debate-auto"
              >
                {run.auto ? <Pause className="size-3" /> : <Play className="size-3" />}
                {run.auto ? 'Auto on' : 'Auto off'}
              </button>
              <span className="text-[11px] text-muted-foreground">
                {run.awaitingTurn
                  ? `${debater?.modelName} is arguing…`
                  : 'turn dispatched…'}
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={nextRound}
                disabled={finished}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
                data-testid="debate-next"
              >
                <Play className="size-3" />
                Next round ({nextDebater(run).modelName})
              </button>
              <span className="text-[11px] text-muted-foreground">
                {finished
                  ? 'Debate finished.'
                  : 'Manual mode — advance when ready.'}
              </span>
            </>
          )}
        </div>

        {finished && !winnerRecorded ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/[0.06]">
            <span className="text-[10px] text-muted-foreground/70">Who made the better case?</span>
            {run.models.map((m) => (
              <button
                key={m.modelId}
                type="button"
                disabled={postingWinner !== null}
                onClick={() => void recordWinner(m)}
                className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
                data-testid={`debate-winner-${m.modelId}`}
              >
                {postingWinner === m.modelId ? 'Recording…' : m.modelName}
              </button>
            ))}
            <span className="text-[10px] text-muted-foreground/50">
              Feeds the routing-evidence loop.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
