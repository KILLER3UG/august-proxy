/**
 * Live context-window measurement per session.
 *
 * The backend emits one `contextPressure` SSE event per turn carrying the
 * server-accurate `totalTokens` / `maxContext` / `remainingTokens` produced
 * by `computeBudget` (the proper tokenizer chain over system + tools +
 * messages). The handler used to destructure those fields and drop them,
 * leaving the composer's ContextRing on the persisted `usage_events` value —
 * which is stale after a reload/session switch, and whose denominator was
 * the hardcoded 128k fallback whenever the model carried no contextWindow.
 *
 * This store is the ring's preferred source; the persisted session-usage
 * value is the floor it never reports below (see ChatThread). Keyed per
 * session so concurrent chats do not overwrite each other.
 */

import { create } from 'zustand';

export interface ContextLive {
  totalTokens: number;
  maxContext: number;
  remainingTokens?: number;
  /** Server-reported percent; 0 when the model produced no measurement. */
  usedPct: number;
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
  const rawPct = Number(ctx.contextUsedPct);
  useContextLiveStore.setState((prev) => ({
    bySession: {
      ...prev.bySession,
      [sessionId]: {
        totalTokens,
        maxContext,
        remainingTokens:
          ctx.remainingTokens != null ? Number(ctx.remainingTokens) || 0 : undefined,
        usedPct: Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0,
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
