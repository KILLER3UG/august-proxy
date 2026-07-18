/**
 * Live turn activity for the right-side Workbench panel.
 * Keeps users informed while chat thoughts are collapsed mid-stream.
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

interface LiveActivityState {
  sessionId: string | null;
  headline: string;
  items: LiveActivityItem[];
}

export const useLiveActivityStore = create<LiveActivityState>(() => ({
  sessionId: null,
  headline: '',
  items: [],
}));

const MAX_ITEMS = 40;

export function publishLiveActivity(input: {
  sessionId: string;
  headline: string;
  items: LiveActivityItem[];
}): void {
  useLiveActivityStore.setState({
    sessionId: input.sessionId,
    headline: input.headline,
    items: input.items.slice(-MAX_ITEMS),
  });
}

export function clearLiveActivity(sessionId?: string | null): void {
  const cur = useLiveActivityStore.getState();
  if (sessionId && cur.sessionId && cur.sessionId !== sessionId) return;
  useLiveActivityStore.setState({ sessionId: null, headline: '', items: [] });
}
