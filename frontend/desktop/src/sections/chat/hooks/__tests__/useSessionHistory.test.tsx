import { StrictMode, type PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types/chat';

vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/api/workbench', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/workbench')>(),
  undoWorkbenchLastTurn: vi.fn().mockResolvedValue({ message: 'Undid last turn' }),
}));

import { api } from '@/api/client';
import { undoWorkbenchLastTurn } from '@/api/workbench';
import { dispatchUiAction } from '@/api/ui-events';
import { isSessionIdTombstoned, tombstoneSessionId } from '@/store/sessions';
import { useSessionHistory } from '../useSessionHistory';
import { useChatUiActions } from '../useChatUiActions';
import { useSessionStream } from '../useSessionStream';
import { useSessionStreamStore, evictSessionStreamState, persistMessagesDebounced } from '../../stream/session-stream-store';
import { ensureSessionHistory, injectSessionMessage } from '../../stream/session-history';

const id = 'wb_history_review';
const turn: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'hello', timestamp: '2026-09-16T10:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'answer', timestamp: '2026-09-16T10:00:01Z' },
];
const injected: ChatMessage = {
  id: 'qm-1', role: 'user', content: 'follow up', timestamp: '2026-09-16T10:00:02Z', queued: true,
};

function deferred() {
  let resolve!: (value: { messages: ChatMessage[] }) => void;
  const promise = new Promise<{ messages: ChatMessage[] }>((done) => { resolve = done; });
  return { promise, resolve };
}
function Wrapper({ children }: PropsWithChildren) {
  return <StrictMode><MemoryRouter>{children}</MemoryRouter></StrictMode>;
}
function useThread(sessionId: string) {
  const stream = useSessionStream(sessionId);
  useSessionHistory(sessionId);
  useChatUiActions({
    sessionId,
    messages: stream.messages,
    setMessages: stream.setMessages,
    streaming: false,
    workbenchSession: null,
    setWorkbenchSession: stream.setWorkbenchSession,
    setWorkbenchMode: () => {},
    activeSession: null,
  });
  return stream;
}
function persisted(sessionId = id): ChatMessage[] {
  return JSON.parse(localStorage.getItem(`chat_messages_${sessionId}`) ?? '[]') as ChatMessage[];
}

beforeEach(() => {
  localStorage.clear();
  useSessionStreamStore.setState({ bySession: {} });
  vi.clearAllMocks();
});

describe('session history', () => {
  it('does not let a pending stream persistence overwrite Undo', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(`chat_messages_${id}`, JSON.stringify(turn));
      const mounted = renderHook(() => useThread(id), { wrapper: Wrapper });
      persistMessagesDebounced(id, turn);
      await act(async () => { dispatchUiAction({ action: 'undo_last_turn', target: 'active' }); });
      expect(mounted.result.current.messages).toEqual([]);
      await act(async () => { vi.advanceTimersByTime(1001); });
      expect(persisted()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares a real StrictMode request and keeps Undo empty across remounts', async () => {
    const request = deferred();
    vi.mocked(api.get).mockReturnValue(request.promise);
    const mounted = renderHook(() => useThread(id), { wrapper: Wrapper });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve({ messages: turn }); });
    expect(mounted.result.current.messages.map(m => m.id)).toEqual(['u1', 'a1']);
    expect(persisted()).toHaveLength(2);

    await act(async () => { dispatchUiAction({ action: 'undo_last_turn', target: 'active' }); });
    expect(undoWorkbenchLastTurn).toHaveBeenCalledWith(id);
    expect(mounted.result.current.messages).toEqual([]);
    expect(persisted()).toEqual([]);
    mounted.unmount();
    evictSessionStreamState(id);
    const restored = renderHook(() => useThread(id), { wrapper: Wrapper });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(restored.result.current.messages).toEqual([]);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('vetoes late backend history after the real Undo handler clears an injected turn', async () => {
    const request = deferred();
    vi.mocked(api.get).mockReturnValue(request.promise);
    const mounted = renderHook(() => useThread(id), { wrapper: Wrapper });
    act(() => { injectSessionMessage(id, injected); });
    expect(mounted.result.current.messages).toHaveLength(1);
    await act(async () => { dispatchUiAction({ action: 'undo_last_turn', target: 'active' }); });
    await act(async () => { request.resolve({ messages: [...turn, injected] }); });
    expect(mounted.result.current.messages).toEqual([]);
    expect(persisted()).toEqual([]);
  });

  it('loads backend-only history around an idle injection and persists the merged transcript', async () => {
    const request = deferred();
    vi.mocked(api.get).mockReturnValue(request.promise);
    injectSessionMessage(id, injected);
    expect(localStorage.getItem(`chat_messages_${id}`)).toBeNull();
    request.resolve({ messages: turn });
    await ensureSessionHistory(id);
    expect(persisted().map(m => m.id)).toEqual(['u1', 'a1', 'qm-1']);
    injectSessionMessage(id, injected);
    expect(useSessionStreamStore.getState().bySession[id].messages).toHaveLength(3);
  });

  it('reconciles an injected message with its different backend row id', async () => {
    const request = deferred();
    vi.mocked(api.get).mockReturnValue(request.promise);
    injectSessionMessage(id, injected);
    request.resolve({ messages: [...turn, { ...injected, id: 'db-row', queued: undefined }] });
    await ensureSessionHistory(id);
    expect(persisted().map(m => m.id)).toEqual(['u1', 'a1', 'qm-1']);
  });

  it('keeps late responses scoped to their original session', async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(api.get).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mounted = renderHook(({ sid }) => useThread(sid), { initialProps: { sid: id }, wrapper: Wrapper });
    mounted.rerender({ sid: 'wb_other' });
    await act(async () => { first.resolve({ messages: turn }); });
    expect(mounted.result.current.messages).toEqual([]);
    await act(async () => { second.resolve({ messages: [injected] }); });
    expect(mounted.result.current.messages.map(m => m.id)).toEqual(['qm-1']);
    expect(persisted().map(m => m.id)).toEqual(['u1', 'a1']);
  });

  it('does not resurrect an evicted session when its response arrives', async () => {
    const request = deferred();
    vi.mocked(api.get).mockReturnValue(request.promise);
    const pending = ensureSessionHistory(id);
    evictSessionStreamState(id);
    request.resolve({ messages: turn });
    await pending;
    expect(useSessionStreamStore.getState().bySession[id]).toBeUndefined();
    expect(localStorage.getItem(`chat_messages_${id}`)).toBeNull();
  });

  it('does not let pending persistence resurrect a deleted session', async () => {
    vi.useFakeTimers();
    try {
      const deleted = 'wb_history_deleted';
      localStorage.setItem(`chat_messages_${deleted}`, JSON.stringify(turn));
      persistMessagesDebounced(deleted, turn);
      tombstoneSessionId(deleted);
      localStorage.removeItem(`chat_messages_${deleted}`);
      expect(isSessionIdTombstoned(deleted)).toBe(true);
      await act(async () => { vi.advanceTimersByTime(1001); });
      expect(localStorage.getItem(`chat_messages_${deleted}`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries failed history hydration with bounded idle backoff', async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error('offline');
      vi.mocked(api.get)
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure);

      await ensureSessionHistory(id);
      expect(api.get).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });
      expect(api.get).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      expect(api.get).toHaveBeenCalledTimes(3);

      await act(async () => {
        vi.advanceTimersByTime(8_000);
        await Promise.resolve();
      });
      expect(api.get).toHaveBeenCalledTimes(4);

      await act(async () => {
        vi.advanceTimersByTime(8_000);
        await Promise.resolve();
      });
      expect(api.get).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
