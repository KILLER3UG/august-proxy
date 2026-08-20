/**
 * Per-session store for pending capability-profile suggestions.
 *
 * The backend emits `modelProfileSuggestion` when its capability auto-detect
 * (trace fingerprinting) finds a better toolSurface for a model. The
 * ModelProfileSuggestionBar renders Apply / Dismiss; Apply persists via
 * POST /api/models/profile (shared with the AUGUST_AUTO_PROFILE=1 path).
 */
import { create } from 'zustand';

export interface ModelProfileSuggestion {
  model: string;
  toolSurface?: string;
  reason?: string;
  message?: string;
  at: number;
}

interface ModelProfileState {
  bySession: Record<string, ModelProfileSuggestion>;
}

export const useModelProfileStore = create<ModelProfileState>(() => ({
  bySession: {},
}));

export const $modelProfileSuggestions = {
  get: (): Record<string, ModelProfileSuggestion> =>
    useModelProfileStore.getState().bySession,
  subscribe: (listener: (bySession: Record<string, ModelProfileSuggestion>) => void): (() => void) => {
    listener(useModelProfileStore.getState().bySession);
    return useModelProfileStore.subscribe((s) => listener(s.bySession));
  },
};

/** Register (or replace) a pending suggestion for a session. */
export function setModelProfileSuggestion(
  sessionId: string,
  suggestion: Omit<ModelProfileSuggestion, 'at'>,
): void {
  const prev = useModelProfileStore.getState().bySession;
  useModelProfileStore.setState({
    bySession: { ...prev, [sessionId]: { ...suggestion, at: Date.now() } },
  });
}

/** Remove a suggestion (applied or dismissed). */
export function clearModelProfileSuggestion(sessionId: string): void {
  const prev = useModelProfileStore.getState().bySession;
  if (!prev[sessionId]) return;
  const next = { ...prev };
  delete next[sessionId];
  useModelProfileStore.setState({ bySession: next });
}
