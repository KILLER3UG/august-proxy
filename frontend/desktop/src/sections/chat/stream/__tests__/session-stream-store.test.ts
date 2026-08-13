import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types/chat';

const persistSpy = vi.hoisted(() => vi.fn());

vi.mock('../../message-storage', () => ({
  loadMessagesForSession: () => [],
  persistMessages: (...args: unknown[]) => persistSpy(...args),
}));

import {
  flushPersistMessages,
  persistMessagesDebounced,
} from '../session-stream-store';

const msg = (id: string): ChatMessage =>
  ({
    id,
    role: 'assistant',
    content: id,
    blocks: [],
  }) as unknown as ChatMessage;

describe('persistMessagesDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistSpy.mockClear();
  });

  afterEach(() => {
    flushPersistMessages('sess-debounce-test');
    vi.useRealTimers();
  });

  it('coalesces rapid stream flushes into one persist with the latest messages', () => {
    persistMessagesDebounced('sess-debounce-test', [msg('a')]);
    // 30 token flushes land inside the 1s window — only the last must win.
    for (let i = 0; i < 30; i++) {
      persistMessagesDebounced('sess-debounce-test', [msg('a'), msg(`t${i}`)]);
    }
    expect(persistSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [sessionId, messages] = persistSpy.mock.calls[0] as [string, ChatMessage[]];
    expect(sessionId).toBe('sess-debounce-test');
    expect(messages.map((m) => m.id)).toEqual(['a', 't29']);
  });

  it('does not write again for a repeat flush after the window closed (timer gone)', () => {
    persistMessagesDebounced('sess-debounce-test', [msg('a')]);
    vi.advanceTimersByTime(1000);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    persistMessagesDebounced('sess-debounce-test', [msg('a')]);
    vi.advanceTimersByTime(1000);
    expect(persistSpy).toHaveBeenCalledTimes(2);
  });

  it('flushPersistMessages writes pending state immediately on stream end', () => {
    persistMessagesDebounced('sess-debounce-test', [msg('a')]);
    persistMessagesDebounced('sess-debounce-test', [msg('a'), msg('b')]);
    expect(persistSpy).not.toHaveBeenCalled();

    flushPersistMessages('sess-debounce-test');

    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [, messages] = persistSpy.mock.calls[0] as [string, ChatMessage[]];
    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    // The pending timer must not fire later and double-write.
    vi.advanceTimersByTime(5000);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
