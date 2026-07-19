/**
 * Live turn activity for the right-side Workbench panel.
 * Keeps users informed while chat thoughts are collapsed mid-stream.
 * State is keyed per session so concurrent chats do not overwrite each other.
 */

import { create } from 'zustand';

export type LiveActivityKind = 'thinking' | 'view' | 'edit' | 'run' | 'tool';

export interface LiveActivityItem {
  id: string;
  kind: LiveActivityKind;
  label: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
  at: number;
}

export interface SessionLiveActivity {
  headline: string;
  items: LiveActivityItem[];
}

interface LiveActivityState {
  bySession: Record<string, SessionLiveActivity>;
}

export const useLiveActivityStore = create<LiveActivityState>(() => ({
  bySession: {},
}));

const MAX_ITEMS = 40;

export function publishLiveActivity(input: {
  sessionId: string;
  headline: string;
  items: LiveActivityItem[];
}): void {
  if (!input.sessionId) return;
  useLiveActivityStore.setState((prev) => ({
    bySession: {
      ...prev.bySession,
      [input.sessionId]: {
        headline: input.headline,
        items: input.items.slice(-MAX_ITEMS),
      },
    },
  }));
}

export function clearLiveActivity(sessionId?: string | null): void {
  if (!sessionId) {
    useLiveActivityStore.setState({ bySession: {} });
    return;
  }
  useLiveActivityStore.setState((prev) => {
    if (!(sessionId in prev.bySession)) return prev;
    const next = { ...prev.bySession };
    delete next[sessionId];
    return { bySession: next };
  });
}

/** Selector helper for a single session's activity. */
export function selectSessionLiveActivity(
  state: LiveActivityState,
  sessionId: string | null | undefined,
): SessionLiveActivity {
  if (!sessionId) return { headline: '', items: [] };
  return state.bySession[sessionId] ?? { headline: '', items: [] };
}
