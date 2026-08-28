/**
 * Live prompt-cache stats per session (Bug 9a).
 *
 * The backend emits one `contextPressure` SSE event per turn carrying the
 * universal prompt-cache split (`promptCache: { hitTokens, missTokens,
 * hitRate }`). The composer's ContextRing subscribes here so the cache hit
 * rate updates the moment the turn's event lands — instead of waiting for
 * the aggregated session-usage poll. Keyed per session so concurrent chats
 * do not overwrite each other.
 */

import { create } from 'zustand';

export interface PromptCacheLive {
  hitTokens: number;
  missTokens: number;
  hitRate?: number;
  at: number;
}

interface PromptCacheLiveState {
  bySession: Record<string, PromptCacheLive>;
}

export const usePromptCacheLiveStore = create<PromptCacheLiveState>(() => ({
  bySession: {},
}));

export function setPromptCacheLive(
  sessionId: string,
  cache: { hitTokens?: number; missTokens?: number; hitRate?: number } | null | undefined,
): void {
  if (!sessionId || !cache) return;
  const hitTokens = Number(cache.hitTokens ?? 0) || 0;
  const missTokens = Number(cache.missTokens ?? 0) || 0;
  if (hitTokens <= 0 && missTokens <= 0) return;
  usePromptCacheLiveStore.setState((prev) => ({
    bySession: {
      ...prev.bySession,
      [sessionId]: {
        hitTokens,
        missTokens,
        hitRate: typeof cache.hitRate === 'number' ? cache.hitRate : undefined,
        at: Date.now(),
      },
    },
  }));
}

export function clearPromptCacheLive(sessionId?: string | null): void {
  if (!sessionId) {
    usePromptCacheLiveStore.setState({ bySession: {} });
    return;
  }
  usePromptCacheLiveStore.setState((prev) => {
    if (!(sessionId in prev.bySession)) return prev;
    const next = { ...prev.bySession };
    delete next[sessionId];
    return { bySession: next };
  });
}

/** Selector helper for a single session's live cache stats. */
export function selectPromptCacheLive(
  state: PromptCacheLiveState,
  sessionId: string | null | undefined,
): PromptCacheLive | null {
  if (!sessionId) return null;
  return state.bySession[sessionId] ?? null;
}
