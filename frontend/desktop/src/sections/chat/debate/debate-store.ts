/**
 * Debate mode (A5) — two models take turns arguing in the CURRENT chat
 * session; an optional judge summarizes at the end.
 *
 * Each round is a real turn with a per-turn model override, so the whole
 * debate lands in the session transcript. The store tracks round/phase;
 * makeStreamHandlers calls debateTurnDone() when a turn we initiated ends,
 * and the orchestrator (DebateView) advances to the next round (auto or
 * manual).
 */
import { create } from 'zustand';
import type { ModelItem } from '../model-display';

export interface DebateLane {
  modelId: string;
  modelName: string;
  provider: string;
}

export interface DebateRun {
  runId: string;
  sessionId: string;
  prompt: string;
  /** Alternating debaters. */
  models: DebateLane[];
  /** Optional judge — a final summarizing turn. */
  judge?: DebateLane;
  maxRounds: number;
  /** 0 = not started; >=1 = rounds completed. */
  round: number;
  phase: 'config' | 'running' | 'done';
  auto: boolean;
  /** True while we are waiting for a turn we initiated to finish. */
  awaitingTurn: boolean;
  /** True once the judge summary turn has been dispatched. */
  judgeSent?: boolean;
  startedAt: number;
}

interface DebateState {
  run: DebateRun | null;
  /** Per-session callbacks fired when an initiated debate turn finishes. */
  turnDoneHandlers: Map<string, () => void>;
}

export const useDebateStore = create<DebateState>(() => ({
  run: null,
  turnDoneHandlers: new Map(),
}));

export function setDebateRun(run: DebateRun | null): void {
  useDebateStore.setState({ run });
}

export function clearDebateRun(): void {
  useDebateStore.setState({ run: null });
}

/** The debater whose turn it is next (alternates across rounds). */
export function nextDebater(run: DebateRun): DebateLane {
  return run.models[run.round % run.models.length];
}

export function registerDebateTurnDone(
  sessionId: string,
  handler: () => void,
): () => void {
  const handlers = useDebateStore.getState().turnDoneHandlers;
  handlers.set(sessionId, handler);
  useDebateStore.setState({ turnDoneHandlers: new Map(handlers) });
  return () => {
    const next = useDebateStore.getState().turnDoneHandlers;
    next.delete(sessionId);
    useDebateStore.setState({ turnDoneHandlers: new Map(next) });
  };
}

/** Called by makeStreamHandlers when a turn we initiated finishes. */
export function debateTurnDone(sessionId: string): void {
  const run = useDebateStore.getState().run;
  if (!run || run.sessionId !== sessionId || !run.awaitingTurn) return;
  const handler = useDebateStore.getState().turnDoneHandlers.get(sessionId);
  handler?.();
}

/** True when `sessionId` is inside an active debate run (used by the
 *  stream handlers to know when a finished turn belongs to a debate). */
export function isDebateSession(sessionId: string): boolean {
  const run = useDebateStore.getState().run;
  return !!run && run.sessionId === sessionId && run.awaitingTurn;
}

export function debateRoundMessage(run: DebateRun, round: number): string {
  const debater = nextDebater(run);
  const other = run.models.find((m) => m.modelId !== debater.modelId);
  const r = round + 1; // 1-based display
  if (r === 1) {
    return run.prompt;
  }
  const lines = [
    `[DEBATE round ${r} — ${debater.modelName}]`,
    `You are ${debater.modelName} in a structured debate with ${other?.modelName ?? 'the other model'}.`,
    'The conversation history above contains everything said so far.',
    r % 2 === 0
      ? `Respond as ${debater.modelName}: critique the previous position and present your own with concrete reasoning.`
      : `Respond as ${debater.modelName}: defend your position against the critique above and counter it.`,
  ];
  return lines.join('\n');
}

export function debateJudgeMessage(run: DebateRun): string {
  const judge = run.judge;
  const names = run.models.map((m) => m.modelName).join(' and ');
  return [
    `[DEBATE SUMMARY — judge ${judge?.modelName ?? 'judge'}]`,
    `You are the judge of this debate between ${names}.`,
    'Review the full exchange above, summarize both positions fairly, and',
    'declare which position was stronger — with concrete reasons. End with a',
    'clear "Winner: <name>" line.',
  ].join('\n');
}
