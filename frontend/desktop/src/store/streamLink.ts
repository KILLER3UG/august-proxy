/**
 * SSE link state per workbench session id (`wb_*`, the key the stream itself
 * uses — not the sidebar's `sess_*` id).
 *
 * The reconnect loop in `api/workbench/stream.ts` retries with backoff and
 * used to log it to the console only, so a dropped stream looked like a hung
 * assistant reply. Each retry marks the session as reconnecting; the next
 * established connection clears it.
 */
import { create } from 'zustand';

export interface StreamLinkState {
  /** 1-based attempt number of the most recent backoff. */
  attempt: number;
  /** epoch ms of that backoff, for staleness checks. */
  at: number;
}

interface StreamLinkStore {
  bySession: Record<string, StreamLinkState | null>;
}

const useStore = create<StreamLinkStore>(() => ({ bySession: {} }));

function write(sessionId: string, next: StreamLinkState | null): void {
  const prev = useStore.getState().bySession;
  const cur = prev[sessionId] ?? null;
  if (cur === next || cur?.attempt === next?.attempt) return;
  useStore.setState({ bySession: { ...prev, [sessionId]: next } });
}

export function markStreamReconnecting(sessionId: string, attempt: number): void {
  if (!sessionId) return;
  write(sessionId, { attempt, at: Date.now() });
}

export function clearStreamReconnecting(sessionId: string): void {
  if (!sessionId) return;
  write(sessionId, null);
}

export function getStreamReconnecting(sessionId: string): StreamLinkState | null {
  return useStore.getState().bySession[sessionId] ?? null;
}

export function useStreamReconnecting(sessionId?: string | null): StreamLinkState | null {
  return useStore((s) => (sessionId ? s.bySession[sessionId] ?? null : null));
}
