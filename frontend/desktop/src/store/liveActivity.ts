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

/** Latest update_state phase/step (executionState SSE event). */
export interface ExecutionStateLive {
  phase: string;
  step: number;
  at: number;
}

export interface SessionLiveActivity {
  headline: string;
  items: LiveActivityItem[];
  execution?: ExecutionStateLive;
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
        // The timeline rebuilds items every rAF — preserve the phase/step
        // chip published by the executionState SSE handler.
        execution: prev.bySession[input.sessionId]?.execution,
      },
    },
  }));
}

export function publishExecutionState(sessionId: string, phase: string, step: number): void {
  if (!sessionId || !phase) return;
  useLiveActivityStore.setState((prev) => {
    const entry = prev.bySession[sessionId];
    return {
      bySession: {
        ...prev.bySession,
        [sessionId]: {
          headline: entry?.headline ?? '',
          items: entry?.items ?? [],
          execution: { phase, step, at: Date.now() },
        },
      },
    };
  });
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
