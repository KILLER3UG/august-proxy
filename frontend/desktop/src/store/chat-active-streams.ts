/**
 * chat-active-streams — lightweight poller for `/api/workbench/chat/active`
 * so the session sidebar can show a live pulse on any session whose
 * backend generation is currently running, even if the user isn't viewing
 * that session.
 *
 * The poll interval is intentionally generous (3 s) — the active-state
 * endpoint is cheap (one map lookup) and the sidebar is the only consumer.
 */

import { create } from 'zustand';
import { api } from '@/api/client';

// Fallback only — live chat.active / chat.idle events update this store instantly.
const POLL_INTERVAL_MS = 15_000;

interface ActiveChatStreamsState {
  active: Record<string, 'streaming'>;
}

export const useActiveChatStreamsStore = create<ActiveChatStreamsState>(() => ({
  active: {},
}));

/** Nanostores-shaped shim for imperative get/set callers. */
export const $activeChatSessions = {
  get: (): Record<string, 'streaming'> => useActiveChatStreamsStore.getState().active,
  set: (active: Record<string, 'streaming'>): void => {
    useActiveChatStreamsStore.setState({ active });
  },
  subscribe: (listener: (active: Record<string, 'streaming'>) => void): (() => void) => {
    listener(useActiveChatStreamsStore.getState().active);
    return useActiveChatStreamsStore.subscribe((s) => listener(s.active));
  },
};

let pollHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function poll(): Promise<void> {
  if (inFlight) return;
  if (typeof window === 'undefined') return;
  inFlight = true;
  try {
    const active = await api.get<Record<string, string>>('/api/workbench/chat/active');
    const next: Record<string, 'streaming'> = {};
    for (const [id, status] of Object.entries(active)) {
      if (status === 'streaming') next[id] = 'streaming';
    }
    useActiveChatStreamsStore.setState({ active: next });
  } catch (_e: unknown) {
    // Network errors are non-fatal — keep the last known state.
  } finally {
    inFlight = false;
  }
}

export function startChatActiveStreamsPoller(): void {
  if (typeof window === 'undefined') return;
  if (pollHandle) return;
  // Kick off an immediate poll so the first render after a page load
  // shows the right state, then settle into the interval.
  void poll();
  pollHandle = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}

export function stopChatActiveStreamsPoller(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
