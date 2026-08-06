/**
 * Per-session store for proactive memory suggestions ("August noticed…").
 *
 * The workbench `done` SSE event may carry `memorySuggestions` — cheap
 * deterministic preference candidates extracted from the last user message.
 * The MemorySuggestionBar renders them as one-click "Save as memory" chips;
 * Save posts to PATCH /api/brain/profile (addFact), Dismiss removes locally.
 */
import { create } from 'zustand';

interface MemorySuggestionsState {
  bySession: Record<string, string[]>;
}

export const useMemorySuggestionsStore = create<MemorySuggestionsState>(() => ({
  bySession: {},
}));

export const $memorySuggestions = {
  get: (): Record<string, string[]> => useMemorySuggestionsStore.getState().bySession,
  subscribe: (listener: (bySession: Record<string, string[]>) => void): (() => void) => {
    listener(useMemorySuggestionsStore.getState().bySession);
    return useMemorySuggestionsStore.subscribe((s) => listener(s.bySession));
  },
};

/** Replace the suggestions for a session (each done event carries its own). */
export function setMemorySuggestions(sessionId: string, items: string[]): void {
  const prev = useMemorySuggestionsStore.getState().bySession;
  useMemorySuggestionsStore.setState({ bySession: { ...prev, [sessionId]: items } });
}

/** Drop one suggestion (saved or dismissed) without clearing the rest. */
export function dismissMemorySuggestion(sessionId: string, text: string): void {
  const prev = useMemorySuggestionsStore.getState().bySession;
  const list = prev[sessionId] ?? [];
  const next = list.filter((s) => s !== text);
  if (next.length === list.length) return;
  useMemorySuggestionsStore.setState({ bySession: { ...prev, [sessionId]: next } });
}
