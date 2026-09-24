/* Offline queue replay — the two invariants the old inline flush broke:
 *  1. Attachments (and attachment-only items) survive the replay.
 *  2. An item is dequeued ONLY after the send was accepted; a skipped or
 *     still-offline send keeps it parked and halts the loop. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueOfflineMessage,
  replayOfflineQueue,
  clearOfflineQueue,
  useOfflineQueueStore,
} from '../offline-queue-store';
import type { FileAttachment } from '@/types/chat';

const att = (name: string): FileAttachment => ({
  id: `att-${name}`,
  name,
  size: '10 B',
  type: 'text',
  content: 'hello',
  status: 'ready',
});

beforeEach(() => {
  clearOfflineQueue();
  vi.restoreAllMocks();
});

describe('replayOfflineQueue', () => {
  it('sends attachments and dequeues only after an accepted send', async () => {
    enqueueOfflineMessage('sess_1', 'first', [att('a.txt')]);
    enqueueOfflineMessage('sess_1', 'second', [att('b.txt')]);

    const send = vi.fn().mockResolvedValue('sent' as const);
    const result = await replayOfflineQueue('sess_1', { send, probe: async () => true });

    expect(send).toHaveBeenCalledTimes(2);
    // Attachments ride along on every item.
    expect(send.mock.calls[0][1].attachments?.[0].name).toBe('a.txt');
    expect(send.mock.calls[1][1].attachments?.[0].name).toBe('b.txt');
    // The replay owns the items — it must not let send re-park them.
    expect(send.mock.calls[0][1].noRequeue).toBe(true);
    expect(result).toEqual({ attempted: 2, dequeued: 2, halted: false });
    expect(useOfflineQueueStore.getState().items).toHaveLength(0);
  });

  it('replays an attachment-only message (empty text is a valid item)', async () => {
    enqueueOfflineMessage('sess_1', '', [att('only.txt')]);
    const send = vi.fn().mockResolvedValue('sent' as const);

    const result = await replayOfflineQueue('sess_1', { send, probe: async () => true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('');
    expect(send.mock.calls[0][1].attachments).toHaveLength(1);
    expect(result.dequeued).toBe(1);
    expect(useOfflineQueueStore.getState().items).toHaveLength(0);
  });

  it('keeps the item parked and halts when the send is skipped', async () => {
    enqueueOfflineMessage('sess_1', 'one');
    enqueueOfflineMessage('sess_1', 'two');

    const send = vi.fn().mockResolvedValue('skipped' as const);
    const result = await replayOfflineQueue('sess_1', { send, probe: async () => true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: 1, dequeued: 0, halted: true });
    // BOTH items survive — nothing is dropped or reordered.
    const left = useOfflineQueueStore.getState().items;
    expect(left.map((i) => i.text)).toEqual(['one', 'two']);
  });

  it('keeps the item parked when the backend went offline again mid-replay', async () => {
    enqueueOfflineMessage('sess_1', 'one');
    const send = vi.fn().mockResolvedValue('offline' as const);

    const result = await replayOfflineQueue('sess_1', { send, probe: async () => true });

    expect(result).toEqual({ attempted: 1, dequeued: 0, halted: true });
    expect(useOfflineQueueStore.getState().items).toHaveLength(1);
    // No duplicate parked copy: replay suppressed the send's own re-queue.
    expect(useOfflineQueueStore.getState().items.filter((i) => i.text === 'one')).toHaveLength(1);
  });

  it('does not touch the queue when the probe says the backend is down', async () => {
    enqueueOfflineMessage('sess_1', 'one');
    const send = vi.fn();

    const result = await replayOfflineQueue('sess_1', {
      send: send as never,
      probe: async () => false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, dequeued: 0, halted: true });
    expect(useOfflineQueueStore.getState().items).toHaveLength(1);
  });

  it('only replays items belonging to this session', async () => {
    enqueueOfflineMessage('sess_1', 'mine');
    enqueueOfflineMessage('sess_2', 'theirs');
    const send = vi.fn().mockResolvedValue('sent' as const);

    await replayOfflineQueue('sess_1', { send, probe: async () => true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('mine');
    const left = useOfflineQueueStore.getState().items;
    expect(left).toHaveLength(1);
    expect(left[0].sessionId).toBe('sess_2');
  });
});
