import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../chat-runtime', () => ({
  chatRuntime: { finishTurn: vi.fn() },
}));
vi.mock('@/api/git', () => ({ gitApi: {} }));
vi.mock('@/store/sessions', () => ({
  setSessionStatus: vi.fn(),
  isSessionIdTombstoned: () => false,
  useSessionsStore: {
    getState: () => ({ sessions: [] }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));
vi.mock('../active-stream-controllers', () => ({ activeStreamControllers: new Map() }));
vi.mock('../append-block-event', () => ({ appendBlockEvent: vi.fn() }));

import { bindTurnStreamHandlers } from '../bind-turn-handlers';
import { useSessionStreamStore } from '../session-stream-store';

const UI_ID = 'sess_stream_persist';

beforeEach(() => {
  localStorage.clear();
  useSessionStreamStore.setState({ bySession: {} });
});

describe('bindTurnStreamHandlers', () => {
  it('keeps debounced transcript persistence across live stream updates', async () => {
    vi.useFakeTimers();
    try {
      const bundle = bindTurnStreamHandlers({
        sessionId: UI_ID,
        assistantMsgId: 'a1',
        initialMessages: [],
        turn: { turnId: 'turn-1' } as never,
      }) as unknown as { handlers: Record<string, (data: unknown) => void> };
      const handlers = bundle.handlers;
      const state = useSessionStreamStore.getState().bySession[UI_ID];
      useSessionStreamStore.setState({
        bySession: {
          ...useSessionStreamStore.getState().bySession,
          [UI_ID]: { ...state, history: { status: 'ready' } },
        },
      });

      // The factory persists its placeholder immediately; clear it so the
      // assertion isolates the throttled live update path.
      localStorage.removeItem(`chat_messages_${UI_ID}`);
      handlers.onText({ content: 'streamed text' });
      await vi.advanceTimersByTimeAsync(32);
      expect(localStorage.getItem(`chat_messages_${UI_ID}`)).toBeNull();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        JSON.parse(localStorage.getItem(`chat_messages_${UI_ID}`) ?? '[]'),
      ).toEqual([expect.objectContaining({ id: 'a1', content: 'streamed text' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist a live update while backend history is still loading', async () => {
    vi.useFakeTimers();
    try {
      const bundle = bindTurnStreamHandlers({
        sessionId: UI_ID,
        assistantMsgId: 'a1',
        initialMessages: [],
        turn: { turnId: 'turn-1' } as never,
      }) as unknown as { handlers: Record<string, (data: unknown) => void> };
      const state = useSessionStreamStore.getState().bySession[UI_ID];
      useSessionStreamStore.setState({
        bySession: {
          ...useSessionStreamStore.getState().bySession,
          [UI_ID]: { ...state, history: { status: 'loading' } },
        },
      });
      localStorage.removeItem(`chat_messages_${UI_ID}`);
      bundle.handlers.onText({ content: 'do not snapshot yet' });
      await vi.advanceTimersByTimeAsync(1_032);
      expect(localStorage.getItem(`chat_messages_${UI_ID}`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
