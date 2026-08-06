/**
 * Offline compose queue (C9) — when the backend is unreachable, sends are
 * parked here (localStorage-backed) and flushed automatically when the
 * backend comes back.
 */
import { create } from 'zustand';
import type { FileAttachment } from '@/types/chat';

export interface PendingOfflineMessage {
  id: string;
  sessionId: string;
  text: string;
  attachments?: FileAttachment[];
  at: number;
}

const STORAGE_KEY = 'august_offline_queue';

interface OfflineQueueState {
  items: PendingOfflineMessage[];
}

function load(): PendingOfflineMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(items: PendingOfflineMessage[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {
    /* storage full / unavailable */
  }
}

export const useOfflineQueueStore = create<OfflineQueueState>(() => ({
  items: load(),
}));

export function enqueueOfflineMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
): void {
  const items = useOfflineQueueStore.getState().items;
  const next: PendingOfflineMessage = {
    id: `off_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    text,
    attachments,
    at: Date.now(),
  };
  const merged = [...items, next];
  useOfflineQueueStore.setState({ items: merged });
  persist(merged);
}

/** Remove flushed (or cancelled) items; returns what was removed. */
export function dequeueOfflineMessages(ids: string[]): PendingOfflineMessage[] {
  const items = useOfflineQueueStore.getState().items;
  const removed = items.filter((i) => ids.includes(i.id));
  const next = items.filter((i) => !ids.includes(i.id));
  useOfflineQueueStore.setState({ items: next });
  persist(next);
  return removed;
}

export function clearOfflineQueue(): void {
  useOfflineQueueStore.setState({ items: [] });
  persist([]);
}
