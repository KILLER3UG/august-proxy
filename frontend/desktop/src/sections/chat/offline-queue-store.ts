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

/** Outcome of a replayed (or fresh) composer send. */
export type OfflineSendOutcome = 'sent' | 'queued' | 'error' | 'offline' | 'skipped';

export interface OfflineReplayOptions {
  /**
   * Send one queued item. `attachments` carries the ORIGINAL attachments
   * (attachment-only items are legal), and `noRequeue` tells the sender not
   * to re-park the item when the backend is still unreachable — this replay
   * owns the item until it is dequeued.
   */
  send: (
    text: string,
    options: { attachments?: FileAttachment[]; noRequeue?: boolean },
  ) => Promise<OfflineSendOutcome>;
  /** Reachability probe. When it fails, nothing is sent or dequeued. */
  probe?: () => Promise<boolean>;
}

export interface OfflineReplayResult {
  attempted: number;
  dequeued: number;
  /** True when replay stopped early (backend down or send unavailable). */
  halted: boolean;
}

/** Default probe: the backend health route, capped at 2s. */
async function defaultProbe(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replay this session's parked messages in FIFO order.
 *
 * Two invariants the old inline flush got wrong:
 *  1. Attachments ride along (an attachment-only message is a valid item).
 *  2. An item leaves the queue ONLY after the send was ACCEPTED by the
 *     backend (started / queued / turn errored after dispatch). A skipped or
 *     still-offline send keeps the item parked, and replay stops so the
 *     remaining items are not dropped or reordered.
 */
export async function replayOfflineQueue(
  sessionId: string,
  options: OfflineReplayOptions,
): Promise<OfflineReplayResult> {
  const probe = options.probe ?? defaultProbe;
  if (!(await probe())) {
    return { attempted: 0, dequeued: 0, halted: true };
  }

  const result: OfflineReplayResult = { attempted: 0, dequeued: 0, halted: false };
  while (true) {
    // Re-read each pass: only the head item is eligible, so a concurrent
    // enqueue (or an earlier item still parked) can never be skipped.
    const head = useOfflineQueueStore
      .getState()
      .items.find((i) => i.sessionId === sessionId);
    if (!head) break;

    result.attempted += 1;
    let outcome: OfflineSendOutcome;
    try {
      outcome = await options.send(head.text, {
        attachments: head.attachments,
        noRequeue: true,
      });
    } catch (err) {
      console.warn('[offline-queue] replay send failed', err);
      outcome = 'error';
    }

    if (outcome === 'sent' || outcome === 'queued' || outcome === 'error') {
      dequeueOfflineMessages([head.id]);
      result.dequeued += 1;
      continue;
    }

    // 'offline' (backend went away again) or 'skipped' (send path refused:
    // session still loading, no model, latch busy) — keep this item and stop.
    result.halted = true;
    break;
  }
  return result;
}
