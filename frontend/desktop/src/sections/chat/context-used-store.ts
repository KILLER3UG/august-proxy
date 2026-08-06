/**
 * Per-session store for the last-turn context snapshot ("what August used").
 *
 * The workbench `done` SSE event carries a `context` payload (profile,
 * heuristics, added/recalled memories, ...) captured when the system prompt
 * was built (backend A5). The stream handlers write it here; the composer's
 * ContextUsedBadge renders it. Sessions loaded later (no live event) fall
 * back to GET /api/workbench/sessions/{id}/context.
 */
import { create } from 'zustand';

export interface RecalledMemoryItemLite {
  key?: string;
  category?: string;
  snippet?: string;
}

export interface ContextSnapshot {
  profileSummaryUsed?: boolean;
  heuristicsUsed?: number;
  addedMemories?: number;
  recalledMemories?: RecalledMemoryItemLite[];
  currentContextUsed?: boolean;
  activeProjects?: number;
  coreFactsUsed?: boolean;
  augDirectiveUsed?: boolean;
}

interface ContextUsedState {
  bySession: Record<string, ContextSnapshot | null | undefined>;
}

export const useContextUsedStore = create<ContextUsedState>(() => ({
  bySession: {},
}));

/** Map of sessionId → last-turn context snapshot (undefined = unknown). */
export const $sessionContextUsed = {
  get: (): Record<string, ContextSnapshot | null | undefined> =>
    useContextUsedStore.getState().bySession,
  subscribe: (
    listener: (bySession: Record<string, ContextSnapshot | null | undefined>) => void,
  ): (() => void) => {
    listener(useContextUsedStore.getState().bySession);
    return useContextUsedStore.subscribe((s) => listener(s.bySession));
  },
};

/** Write the snapshot delivered in the turn's `done` event. */
export function setSessionContextUsed(
  sessionId: string,
  snapshot: ContextSnapshot | null | undefined,
): void {
  const prev = useContextUsedStore.getState().bySession;
  if (prev[sessionId] === snapshot) return;
  useContextUsedStore.setState({ bySession: { ...prev, [sessionId]: snapshot } });
}
