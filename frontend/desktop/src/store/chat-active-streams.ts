/**
 * chat-active-streams — lightweight poller for `/api/workbench/chat/active`
 * so the session sidebar can show a live pulse on any session whose
 * backend generation is currently running, even if the user isn't viewing
 * that session.
 *
 * The poll interval is intentionally generous (15 s) — live chat.active /
 * chat.idle events update this store instantly; the poll is a safety net.
 */

import { create } from 'zustand';
import { api } from '@/api/client';

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

/** Optimistically clear one or more session ids (e.g. after Stop). */
export function clearActiveChatStream(...sessionIds: Array<string | null | undefined>): void {
  const ids = sessionIds.filter((id): id is string => !!id);
  if (ids.length === 0) return;
  const prev = useActiveChatStreamsStore.getState().active;
  let changed = false;
  const next = { ...prev };
  for (const id of ids) {
    if (next[id]) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) useActiveChatStreamsStore.setState({ active: next });
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Accept only flat `{ sessionId: 'streaming' }` maps; ignore legacy counters. */
export function normalizeActiveChatMap(raw: unknown): Record<string, 'streaming'> {
  const next: Record<string, 'streaming'> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;
  for (const [id, status] of Object.entries(raw as Record<string, unknown>)) {
    if (id === 'sessions' || id === 'active' || id === 'pending_approvals') continue;
    if (status === 'streaming') next[id] = 'streaming';
  }
  return next;
}

async function poll(): Promise<void> {
  if (inFlight) return;
  if (typeof window === 'undefined') return;
  inFlight = true;
  try {
    const active = await api.get<unknown>('/api/workbench/chat/active');
    useActiveChatStreamsStore.setState({ active: normalizeActiveChatMap(active) });
  } catch (_e: unknown) {
    // Network errors are non-fatal — keep the last known state.
  } finally {
    inFlight = false;
  }
}

export function startChatActiveStreamsPoller(): void {
  if (typeof window === 'undefined') return;
  if (pollHandle) return;
  void poll();
  pollHandle = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}

export function stopChatActiveStreamsPoller(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
