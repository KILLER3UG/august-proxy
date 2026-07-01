/**
 * Per-session store for user messages queued during a streaming response.
 *
 * The SSE event subscriber (chat-stream-manager.ts → ensureSessionSubscriber)
 * writes to this store whenever the backend emits
 * `user_message_queued` / `user_message_dequeued` / `user_message_injected`.
 * ChatThread subscribes via `useStore` and renders the pills + injected
 * user bubbles in real time.
 *
 * The store is kept separate from `$sessionStreamStates` (the per-session
 * message log) because the queue is a short-lived control surface that
 * needs to survive turn-end / session-switch / page-reload (via the
 * GET /api/workbench/chat/queue hydration endpoint).
 */
import { atom } from 'nanostores';
import type { FileAttachment } from '@/types/chat';

export interface QueuedUserMessage {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: string;
}

/** Map of sessionId → FIFO list of currently-queued user messages. */
export const $queuedMessagesBySession = atom<Record<string, QueuedUserMessage[]>>({});

/** Insert or no-op if an entry with this id is already present. */
export function upsertQueuedMessage(sessionId: string, entry: QueuedUserMessage): void {
  const prev = $queuedMessagesBySession.get();
  const list = prev[sessionId] ?? [];
  if (list.some(e => e.id === entry.id)) return;
  $queuedMessagesBySession.set({ ...prev, [sessionId]: [...list, entry] });
}

/** Remove a queued entry by id (no-op if absent). */
export function removeQueuedMessage(sessionId: string, messageId: string): void {
  const prev = $queuedMessagesBySession.get();
  const list = prev[sessionId];
  if (!list) return;
  const next = list.filter(e => e.id !== messageId);
  if (next.length === list.length) return;
  if (next.length === 0) {
    const { [sessionId]: _drop, ...rest } = prev;
    void _drop;
    $queuedMessagesBySession.set(rest);
  } else {
    $queuedMessagesBySession.set({ ...prev, [sessionId]: next });
  }
}

/** Replace the entire queue list for a session (used by hydration and
 *  the SSE `injected` handler to drop drained entries). */
export function setQueuedMessages(sessionId: string, entries: QueuedUserMessage[]): void {
  const prev = $queuedMessagesBySession.get();
  if (entries.length === 0) {
    const { [sessionId]: _drop, ...rest } = prev;
    void _drop;
    $queuedMessagesBySession.set(rest);
  } else {
    $queuedMessagesBySession.set({ ...prev, [sessionId]: entries });
  }
}

/** Drop the queue for a session (called on session switch / reset). */
export function clearQueuedMessages(sessionId: string): void {
  setQueuedMessages(sessionId, []);
}