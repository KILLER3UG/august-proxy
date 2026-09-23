import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types/chat';

const captured = vi.hoisted(() => ({ handlers: null as Record<string, unknown> | null }));

vi.mock('@/api/workbench', () => ({
  streamWorkbenchReconnect: (
    _id: string,
    handlers: Record<string, unknown>,
  ) => {
    captured.handlers = handlers;
    return new Promise<void>(() => {}); // stay attached, never resolve
  },
}));

vi.mock('@/api/client', () => ({
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
}));
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/store/notifications', () => ({ pushNotification: vi.fn() }));
vi.mock('@/lib/browser-store', () => ({ pushBrowserAction: vi.fn() }));

import { ensureSessionSubscriber, detachSessionSubscriber } from '../session-subscriber';
import {
  evictSessionStreamState,
  useSessionStreamStore,
} from '../session-stream-store';
import { useSessionsStore } from '@/store/sessions';

const msg = (id: string, content = id): ChatMessage =>
  ({ id, role: 'assistant', content, blocks: [] }) as unknown as ChatMessage;

const UI_ID = 'sess_inject_test';
const WB_ID = 'wb_inject_test';

beforeEach(() => {
  localStorage.clear();
  detachSessionSubscriber(UI_ID);
  captured.handlers = null;
  useSessionStreamStore.setState({ bySession: {} });
  useSessionsStore.setState({
    sessions: [
      {
        id: UI_ID,
        workbenchSessionId: WB_ID,
        title: 't',
      } as never,
    ],
  });
});

describe('userMessageInjected transcript guard', () => {
  it('seeds the stored transcript instead of injecting into an empty one', () => {
    // The good transcript lives in storage (per-turn persistence wrote it).
    const transcript = [msg('u1', 'hello'), msg('a1', 'hi there')];
    localStorage.setItem(`chat_messages_${UI_ID}`, JSON.stringify(transcript));

    ensureSessionSubscriber(UI_ID);
    const handlers = captured.handlers as unknown as {
      onUserMessageInjected: (d: { messageId: string; sessionId: string; text: string }) => void;
    };
    expect(typeof handlers.onUserMessageInjected).toBe('function');

    evictSessionStreamState(UI_ID);

    handlers.onUserMessageInjected({
      messageId: 'm-9',
      sessionId: WB_ID,
      text: 'injected while idle',
    });

    const after = useSessionStreamStore.getState().bySession[UI_ID].messages;
    expect(after.map((m) => m.id)).toEqual(['u1', 'a1', 'qm-m-9']);

    const persisted = JSON.parse(
      localStorage.getItem(`chat_messages_${UI_ID}`) || '[]',
    ) as ChatMessage[];
    expect(persisted.map((m) => m.id)).toEqual(['u1', 'a1', 'qm-m-9']);
  });

  it('does not inject the same message twice', () => {
    ensureSessionSubscriber(UI_ID);
    const handlers = captured.handlers as unknown as {
      onUserMessageInjected: (d: { messageId: string; sessionId: string; text: string }) => void;
    };
    const payload = { messageId: 'm-1', sessionId: WB_ID, text: 'once' };
    handlers.onUserMessageInjected(payload);
    handlers.onUserMessageInjected(payload);
    const after = useSessionStreamStore.getState().bySession[UI_ID].messages;
    expect(after.filter((m) => m.id === 'qm-m-1').length).toBe(1);
  });
});
