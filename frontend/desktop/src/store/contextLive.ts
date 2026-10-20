/**
 * Live context-window measurement per session.
 *
 * The backend emits one `contextPressure` SSE event per turn carrying the
 * server-accurate `totalTokens` / `maxContext` / `remainingTokens` produced
 * by `computeBudget` (the proper tokenizer chain over system + tools +
 * messages). The handler used to destructure those fields and drop them,
 * leaving any live readout on the persisted `usage_events` value —
 * which is stale after a reload/session switch, and whose denominator was
 * the hardcoded 128k fallback whenever the model carried no contextWindow.
 *
 * This store is the server-accurate source; the persisted session-usage
 * value is the floor a gauge never reports below. Keyed per
 * session so concurrent chats do not overwrite each other.
 *
 * It is READ by exactly one surface: `sections/chat/composer/
 * ContextUsageReadout.tsx`, the context percentage the reference puts at the
 * far right of the row under the composer card. The reader is per SESSION,
 * so switching chats swaps the key and the previous session's number cannot
 * linger on screen.
 */

import { create } from 'zustand';

export interface ContextLive {
  totalTokens: number;
  maxContext: number;
  remainingTokens?: number;
  /** Server-reported percent of the context window in use.
   *
   *  UNDEFINED means the backend reported no percentage — it is NOT 0. The
   *  repo's rule for a value a path never learned is that the field is
   *  OMITTED, not zeroed: a measured zero ("the window is empty") and an
   *  unmeasured value ("nobody has looked") are different facts, and a
   *  confident `0%` would be a claim about something never read. A session
   *  with no turn yet has no entry at all. */
  usedPct?: number;
  at: number;
}

interface ContextLiveState {
  bySession: Record<string, ContextLive>;
}

export const useContextLiveStore = create<ContextLiveState>(() => ({
  bySession: {},
}));

export function setContextLive(
  sessionId: string,
  ctx: {
    totalTokens?: number | null;
    maxContext?: number | null;
    remainingTokens?: number | null;
    contextUsedPct?: number | null;
  } | null | undefined,
): void {
  if (!sessionId || !ctx) return;
  const totalTokens = Number(ctx.totalTokens ?? 0) || 0;
  const maxContext = Number(ctx.maxContext ?? 0) || 0;
  if (totalTokens <= 0 || maxContext <= 0) return;
  // `null` is absence, not zero: `Number(null)` is 0, which would turn a
  // missing measurement into a confident "0% used".
  const rawPct = ctx.contextUsedPct == null ? Number.NaN : Number(ctx.contextUsedPct);
  useContextLiveStore.setState((prev) => ({
    bySession: {
      ...prev.bySession,
      [sessionId]: {
        totalTokens,
        maxContext,
        remainingTokens:
          ctx.remainingTokens != null ? Number(ctx.remainingTokens) || 0 : undefined,
        usedPct: Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : undefined,
        at: Date.now(),
      },
    },
  }));
}

export function clearContextLive(sessionId?: string | null): void {
  if (!sessionId) {
    useContextLiveStore.setState({ bySession: {} });
    return;
  }
  useContextLiveStore.setState((prev) => {
    if (!(sessionId in prev.bySession)) return prev;
    const next = { ...prev.bySession };
    delete next[sessionId];
    return { bySession: next };
  });
}

/** Selector helper for a single session's live context measurement. */
export function selectContextLive(
  state: ContextLiveState,
  sessionId: string | null | undefined,
): ContextLive | null {
  if (!sessionId) return null;
  return state.bySession[sessionId] ?? null;
}
