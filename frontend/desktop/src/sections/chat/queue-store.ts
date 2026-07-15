/**
 * Per-session store for user messages queued during a streaming response.
 *
 * The SSE event subscriber (chat-stream-manager.ts → ensureSessionSubscriber)
 * writes to this store whenever the backend emits
 * `userMessageQueued` / `userMessageDequeued` / `userMessageInjected`.
 * ChatThread subscribes via the Zustand hook and renders the pills +
 * injected user bubbles in real time.
 *
 * The store is kept separate from `$sessionStreamStates` (the per-session
 * message log) because the queue is a short-lived control surface that
 * needs to survive turn-end / session-switch / page-reload (via the
 * GET /api/workbench/chat/queue hydration endpoint).
 */
import { create } from 'zustand';
import type { FileAttachment } from '@/types/chat';

export interface QueuedUserMessage {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: string;
  /** queue = follow-up; steer = mid-run course correction */
  kind?: 'queue' | 'steer';
}

interface QueueState {
  bySession: Record<string, QueuedUserMessage[]>;
}

export const useQueuedMessagesStore = create<QueueState>(() => ({
  bySession: {},
}));

/** Map of sessionId → FIFO list of currently-queued user messages. */
export const $queuedMessagesBySession = {
  get: (): Record<string, QueuedUserMessage[]> => useQueuedMessagesStore.getState().bySession,
  set: (bySession: Record<string, QueuedUserMessage[]>): void => {
    useQueuedMessagesStore.setState({ bySession });
  },
  subscribe: (listener: (bySession: Record<string, QueuedUserMessage[]>) => void): (() => void) => {
    listener(useQueuedMessagesStore.getState().bySession);
    return useQueuedMessagesStore.subscribe((s) => listener(s.bySession));
  },
};

/** Insert or no-op if an entry with this id is already present. */
export function upsertQueuedMessage(sessionId: string, entry: QueuedUserMessage): void {
  const prev = useQueuedMessagesStore.getState().bySession;
  const list = prev[sessionId] ?? [];
  if (list.some(e => e.id === entry.id)) return;
  useQueuedMessagesStore.setState({
    bySession: { ...prev, [sessionId]: [...list, entry] },
  });
}

/** Remove a queued entry by id (no-op if absent). */
export function removeQueuedMessage(sessionId: string, messageId: string): void {
  const prev = useQueuedMessagesStore.getState().bySession;
  const list = prev[sessionId];
  if (!list) return;
  const next = list.filter(e => e.id !== messageId);
  if (next.length === list.length) return;
  if (next.length === 0) {
    const { [sessionId]: _drop, ...rest } = prev;
    void _drop;
    useQueuedMessagesStore.setState({ bySession: rest });
  } else {
    useQueuedMessagesStore.setState({ bySession: { ...prev, [sessionId]: next } });
  }
}

/** Replace the entire queue list for a session (used by hydration and
 *  the SSE `injected` handler to drop drained entries). */
export function setQueuedMessages(sessionId: string, entries: QueuedUserMessage[]): void {
  const prev = useQueuedMessagesStore.getState().bySession;
  if (entries.length === 0) {
    const { [sessionId]: _drop, ...rest } = prev;
    void _drop;
    useQueuedMessagesStore.setState({ bySession: rest });
  } else {
    useQueuedMessagesStore.setState({ bySession: { ...prev, [sessionId]: entries } });
  }
}

/** Drop the queue for a session (called on session switch / reset). */
export function clearQueuedMessages(sessionId: string): void {
  setQueuedMessages(sessionId, []);
}
