/**
 * chat-active-streams — lightweight poller for `/api/workbench/chat/active`
 * so the session sidebar can show a live pulse on any session whose
 * backend generation is currently running, even if the user isn't viewing
 * that session.
 *
 * The poll interval is intentionally generous (3 s) — the active-state
 * endpoint is cheap (one map lookup) and the sidebar is the only consumer.
 */

import { atom } from 'nanostores';

const POLL_INTERVAL_MS = 3000;

export const $activeChatSessions = atom<Record<string, 'streaming'>>({});

let pollHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function poll(): Promise<void> {
  if (inFlight) return;
  if (typeof window === 'undefined') return;
  inFlight = true;
  try {
    const res = await fetch('/api/workbench/chat/active');
    if (!res.ok) return;
    const active: Record<string, string> = await res.json();
    const next: Record<string, 'streaming'> = {};
    for (const [id, status] of Object.entries(active)) {
      if (status === 'streaming') next[id] = 'streaming';
    }
    $activeChatSessions.set(next);
  } catch (_) {
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
  poll();
  pollHandle = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopChatActiveStreamsPoller(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}
